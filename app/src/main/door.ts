import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join, sep } from 'node:path'
import { type HttpRouter, SESSION_HEADER } from './http'
import { realPathOrNearest } from './sessions/inside'

/**
 * The second door (a spike of #54, off unless `TORNO_OUTSIDE_AGENTS=1`): a Unix socket through which an agent torno
 * did not start reaches one project's MCP tools, by way of the stdio bridge `scripts/torno-mcp.mjs`.
 *
 * - The socket is `door.sock` in a folder of the person's own (`doorDir`): made `0700`, refused when it is a link,
 *   is another user's or is open to others; the socket is made `0600`. No TCP port, no file with a secret.
 * - A connection says first, in one line of JSON, which folder it is for and what it says it is
 *   (`{"torno":"hello","folder":…,"client":…,"pid":…}`, the client's word only). Nothing it sends after is
 *   answered until the person has allowed it in the window (`approve`), each connection asked anew. Refused, or for
 *   no project of the open workspace, every request it sends is answered with an error until it goes.
 * - Allowed, it is given a token of its own (`HttpRouter.grant`, that project's MCP path only), which never leaves
 *   this process: each line it sends (one JSON-RPC message) is posted to the MCP server with it, and the answers
 *   are written back a line each. The token is revoked when the connection closes.
 */
export interface DoorDeps {
  http: HttpRouter
  /** The project of the open workspace a folder is (or is inside), by realpath. */
  objectFor(folder: string): { id: string; name: string } | undefined
  /** Whether the person allows this client to use this project's tools, for as long as it stays connected. */
  approve(ask: { objectId: string; name: string; client: string; pid: number | null }): Promise<boolean>
}

export interface Door {
  path: string
  close(): Promise<void>
}

/** The longest line a connection may send: the MCP server's body limit, and some. */
const LINE_LIMIT = 4 * 1024 * 1024 + 1024
/** Lines held while the person is asked. */
const HELD_LIMIT = 64

/** The folder of the socket: the person's runtime folder (`$XDG_RUNTIME_DIR/torno`), else one of theirs in the temporary folder. */
export function doorDir(env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR
  if (runtime && runtime.startsWith('/')) return join(runtime, 'torno')
  const tmp = env.TMPDIR && env.TMPDIR.startsWith('/') ? env.TMPDIR : '/tmp'
  return join(tmp, `torno-${process.getuid?.() ?? 'user'}`)
}

/** Makes the folder `0700`, or checks the one there is: a real folder of this user that no one else may open. */
export function ownFolder(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${dir} is not a folder`)
  if (process.getuid && stat.uid !== process.getuid()) throw new Error(`${dir} is another user's`)
  if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700)
}

/** The messages of an MCP answer: a JSON body, or the `data:` lines of an event stream. */
export function messagesOf(contentType: string | null, body: string): string[] {
  if (body.trim() === '') return []
  if (contentType?.includes('text/event-stream')) {
    const out: string[] = []
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data.trim() !== '') out.push(JSON.stringify(JSON.parse(data)))
    }
    return out
  }
  const value: unknown = JSON.parse(body)
  return (Array.isArray(value) ? value : [value]).map((m) => JSON.stringify(m))
}

/** An error answer to each request (a message with an id) among `lines`. */
function refusals(lines: string[], message: string): string[] {
  const out: string[] = []
  for (const line of lines) {
    try {
      const m = JSON.parse(line) as { id?: unknown; method?: unknown }
      if (m.id !== undefined && m.id !== null && typeof m.method === 'string') out.push(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message } }))
    } catch {
      // not JSON: nothing to answer
    }
  }
  return out
}

/** Whether `inner` is `outer` or inside it. */
export const within = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep)

/**
 * The deepest project of `objects` that `folder` is, or is inside. Both sides are compared by realpath, so a folder
 * named through a link (`/var/…` for `/private/var/…`) is the project it leads to, and one that merely sits beside
 * a project, or leads out of the workspace, is none.
 */
export function projectFor<T extends { dir: string }>(objects: readonly T[], folder: string): T | undefined {
  const there = realPathOrNearest(folder)
  return objects
    .map((o) => ({ o, dir: realPathOrNearest(o.dir) }))
    .filter(({ dir }) => within(there, dir))
    .sort((a, b) => b.dir.length - a.dir.length)[0]?.o
}

export function openDoor(deps: DoorDeps, dir: string = doorDir()): Promise<Door> {
  ownFolder(dir)
  const path = join(dir, 'door.sock')
  // Ours, in a folder only we may open: one a torno that crashed left.
  try {
    if (lstatSync(path).isSocket()) unlinkSync(path)
  } catch {
    // none
  }
  const live = new Set<Socket>()

  const serve = (socket: Socket): void => {
    live.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    let state: 'hello' | 'asking' | 'open' | 'refused' | 'closed' = 'hello'
    /** Why a refused connection is answered with an error, every request it sends until it closes. */
    let refusal = ''
    let held: string[] = []
    let token: string | null = null
    let objectId = ''
    let chain = Promise.resolve()

    const send = (lines: string[]): void => {
      if (state !== 'closed' && lines.length > 0) socket.write(lines.map((l) => `${l}\n`).join(''))
    }
    const end = (): void => {
      state = 'closed'
      socket.end()
    }
    const refuse = (why: string): void => {
      refusal = why
      state = 'refused'
      send(refusals(held, why))
      held = []
    }
    const forward = (line: string): void => {
      chain = chain.then(async () => {
        if (state !== 'open' || token === null) return
        try {
          const res = await fetch(deps.http.url(`/mcp/${encodeURIComponent(objectId)}`), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', [SESSION_HEADER]: token },
            body: line
          })
          const body = await res.text()
          let out: string[]
          try {
            out = messagesOf(res.headers.get('content-type'), body)
          } catch {
            out = refusals([line], `torno answered ${res.status}`)
          }
          send(out)
        } catch (e) {
          send(refusals([line], `torno did not answer: ${e instanceof Error ? e.message : String(e)}`))
        }
      })
    }
    const hello = (line: string): void => {
      let said: { torno?: unknown; folder?: unknown; client?: unknown; pid?: unknown }
      try {
        said = JSON.parse(line)
      } catch {
        return end()
      }
      if (said.torno !== 'hello' || typeof said.folder !== 'string') return end()
      const client = typeof said.client === 'string' ? said.client.replace(/[^\w .@/+-]/g, '').slice(0, 64) || 'unknown' : 'unknown'
      const pid = typeof said.pid === 'number' && Number.isInteger(said.pid) ? said.pid : null
      const folder = realPathOrNearest(said.folder)
      const object = deps.objectFor(folder)
      if (!object) return refuse(`${folder} is no project of the workspace open in torno: open it there, then start the agent in the project's folder`)
      objectId = object.id
      state = 'asking'
      deps
        .approve({ objectId: object.id, name: object.name, client, pid })
        .catch(() => false)
        .then((yes) => {
          if (state === 'closed') return
          if (!yes) return refuse(`The person did not allow this agent to use the tools of ${object.name} in torno`)
          token = deps.http.grant([`/mcp/${encodeURIComponent(object.id)}`])
          state = 'open'
          const waiting = held
          held = []
          for (const l of waiting) forward(l)
        })
    }

    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > LINE_LIMIT && !buffer.includes('\n')) return end()
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (line === '') continue
        if (state === 'hello') hello(line)
        else if (state === 'asking') {
          if (held.length >= HELD_LIMIT) return end()
          held.push(line)
        } else if (state === 'open') forward(line)
        else if (state === 'refused') send(refusals([line], refusal))
      }
    })
    socket.on('close', () => {
      state = 'closed'
      live.delete(socket)
      if (token !== null) deps.http.revoke(token)
      token = null
    })
    socket.on('error', () => socket.destroy())
  }

  const server: Server = createServer(serve)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      chmodSync(path, 0o600)
      resolve({
        path,
        close: () =>
          new Promise((done) => {
            for (const s of live) s.destroy()
            server.close(() => done())
          })
      })
    })
  })
}

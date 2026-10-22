import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

type Handler = (req: IncomingMessage, res: ServerResponse, rest: string[]) => void | Promise<void>

/**
 * torno's one local HTTP server. What the agent's CLI talks to lives under a
 * prefix each: its hooks (/hooks), the MCP server (/mcp).
 *
 * An address holds no secret (`/mcp/<object id>`, `/hooks/<session id>/<event>`). Every request carries, in its
 * `X-Torno-Session` header, a token made for what it asks for (`grant`): a session's is 32 random bytes made when it
 * starts, opens its object's MCP server and its own hooks, and is revoked when it ends. The agent has it in its
 * environment, never on its command line, which every user of the machine can read. Without it another process of
 * this machine, which could find the port, gets 404. Tokens are kept in memory only, never logged (`redact`) and
 * never written to a file.
 */
export interface HttpRouter {
  port: number
  /** The address of a path on this server, as the agent is given it. */
  url(path: string): string
  /**
   * A token of 32 random bytes (base64url) that opens what is below each of `paths` (`/mcp/<object id>`,
   * `/hooks/<session id>`, written as `url` takes them), sent in the `X-Torno-Session` header, until it is revoked.
   */
  grant(paths: string[]): string
  revoke(token: string): void
  /** A text with every token this server made taken out, for whatever is logged or shown of an agent's arguments or output. */
  redact(text: string): string
  /**
   * Requests whose path is `prefix` or below go to `h`, with the path segments after it, decoded, in `rest`: only
   * those that carry a token for what they ask for.
   */
  route(prefix: string, h: Handler): void
  close(): Promise<void>
}

/** What stands for a token in a text it was taken out of. */
export const REDACTED = '<secret>'

/** The header a request carries its token in. */
export const SESSION_HEADER = 'X-Torno-Session'

const hash = (text: string): Buffer => createHash('sha256').update(text).digest()

/** The segments of a path, decoded. Throws on an escape that is none. */
const segmentsOf = (path: string): string[] => path.split('/').filter(Boolean).map(decodeURIComponent)

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

export class BodyTooLarge extends Error {}

/** The body of a request, as text. Rejects with BodyTooLarge once it is longer than `limit` bytes. */
export function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let length = 0
    req.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > limit) {
        // The rest is let through unread, so the answer can still be delivered.
        req.removeAllListeners('data')
        req.resume()
        reject(new BodyTooLarge(`the body is over ${limit} bytes`))
      } else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Why a request is not served, if it is not. The server is for the agent's CLI
 * on this machine, and what it serves (pictures of the person's work, the
 * status of their sessions) is not for a web page open in their browser:
 *   - a browser names the page a cross-origin request comes from in `Origin`;
 *     the CLI sends none, so any request that has one is refused;
 *   - a page whose own name was pointed at 127.0.0.1 (DNS rebinding) is of the
 *     same origin as this server in the browser's eyes, but still asks for it
 *     by that name in `Host`, so only this server's own names are accepted.
 */
function refuse(req: IncomingMessage, port: number): string | null {
  if (req.headers.origin !== undefined) return 'requests from a web page are not accepted'
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return 'the Host header does not name this server'
  return null
}

/**
 * Listens on 127.0.0.1 only, on a port the system chooses. Serves only requests
 * addressed to it by that name, and none that a web page made.
 */
export function startHttp(): Promise<HttpRouter> {
  const routes: { segments: string[]; handler: Handler }[] = []
  /** The tokens that open something: each with its hash and the paths it opens. */
  const granted = new Map<string, { hash: Buffer; paths: string[][] }>()
  /** Every token made in this run, revoked or not: one may still be in a line logged after its session ended. */
  const made: string[] = []
  const redact = (text: string): string => made.reduce((done, token) => done.split(token).join(REDACTED), text)

  /**
   * Whether the token a request carries opens a path, in a time that says nothing of how much of it was right: it is
   * hashed, and the hash compared whole with that of every live token, all of them each time. A missing header, an
   * empty one, and a placeholder the agent's CLI did not expand are no token.
   */
  const opens = (given: string | string[] | undefined, segments: string[]): boolean => {
    if (typeof given !== 'string' || given === '') return false
    const mine = hash(given)
    let open = false
    for (const grant of granted.values()) {
      const same = timingSafeEqual(mine, grant.hash)
      if (same && grant.paths.some((path) => path.every((segment, i) => segments[i] === segment))) open = true
    }
    return open
  }

  const server = createServer((req, res) => {
    const refusal = refuse(req, (server.address() as AddressInfo).port)
    if (refusal) {
      console.error(redact(`${req.method} ${req.url}: refused, ${refusal}`))
      // Unread, the body would hold the answer back.
      req.resume()
      return sendJson(res, 403, { error: refusal })
    }
    let segments: string[]
    try {
      segments = segmentsOf(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    } catch {
      return sendJson(res, 400, { error: 'bad path' })
    }
    const found = routes.find((r) => r.segments.every((segment, i) => segments[i] === segment))
    // Without a token for it there is nothing here, whatever the path: the answer of a path that is not routed.
    if (!found || !opens(req.headers[SESSION_HEADER.toLowerCase()], segments)) {
      req.resume()
      return sendJson(res, 404, { error: 'not found' })
    }
    Promise.resolve()
      .then(() => found.handler(req, res, segments.slice(found.segments.length)))
      .catch((e: unknown) => {
        console.error(redact(`${req.method} ${req.url}: ${e instanceof Error ? e.message : String(e)}`))
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
        else res.end()
      })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        url: (path) => `http://127.0.0.1:${port}/${path.split('/').filter(Boolean).join('/')}`,
        grant(paths) {
          // base64url: 43 characters, none of which a header escapes.
          const token = randomBytes(32).toString('base64url')
          granted.set(token, { hash: hash(token), paths: paths.map(segmentsOf).filter((path) => path.length > 0) })
          made.push(token)
          return token
        },
        revoke(token) {
          granted.delete(token)
        },
        redact,
        route(prefix, handler) {
          routes.push({ segments: prefix.split('/').filter(Boolean), handler })
        },
        close() {
          return new Promise((done) => {
            server.close(() => done())
            server.closeAllConnections()
          })
        }
      })
    })
  })
}

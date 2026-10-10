import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

type Handler = (req: IncomingMessage, res: ServerResponse, rest: string[]) => void | Promise<void>

/**
 * torno's one local HTTP server. What the agent's CLI talks to lives under a
 * prefix each: its hooks (/hooks), the MCP server (/mcp).
 *
 * Every address has a secret of this run after its prefix (`/mcp/<secret>/<object id>`,
 * `/hooks/<secret>/<session id>/<event>`): 32 random bytes, made when the server starts and kept nowhere.
 * Only who was given an address can ask: another process of this machine, which could find the port, gets 404.
 * The secret is never logged (`redact`) and never written to a file: an agent has it in what it is started with.
 */
export interface HttpRouter {
  port: number
  /** The address of a path on this server, as the agent is given it: with the run's secret after the prefix. */
  url(path: string): string
  /** A text with the run's secret taken out, for whatever is logged or shown of an address or of an agent's arguments. */
  redact(text: string): string
  /**
   * Requests whose path is `prefix`, then the secret, or below go to `h`, with the path
   * segments after those, decoded, in `rest`.
   */
  route(prefix: string, h: Handler): void
  close(): Promise<void>
}

/** What stands for the secret in a text it was taken out of. */
export const REDACTED = '<secret>'

/** Whether a segment of a path is the secret, in a time that says nothing of how much of it was right: both are hashed, and the hashes compared whole. */
function isSecret(given: string | undefined, secret: string): boolean {
  if (given === undefined) return false
  const hash = (text: string): Buffer => createHash('sha256').update(text).digest()
  return timingSafeEqual(hash(given), hash(secret))
}

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
  // base64url: 43 characters, none of which a path escapes.
  const secret = randomBytes(32).toString('base64url')
  const redact = (text: string): string => text.split(secret).join(REDACTED)

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
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      segments = path.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      return sendJson(res, 400, { error: 'bad path' })
    }
    const found = routes.find((r) => r.segments.every((segment, i) => segments[i] === segment))
    // Without the secret after the prefix there is nothing here, whatever the path: the answer of a path that is not routed.
    if (!found || !isSecret(segments[found.segments.length], secret)) {
      req.resume()
      return sendJson(res, 404, { error: 'not found' })
    }
    Promise.resolve()
      .then(() => found.handler(req, res, segments.slice(found.segments.length + 1)))
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
        url: (path) => {
          const [prefix, ...rest] = path.split('/').filter(Boolean)
          return `http://127.0.0.1:${port}/${[prefix, secret, ...rest].join('/')}`
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

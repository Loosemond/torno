import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

type Handler = (req: IncomingMessage, res: ServerResponse, rest: string[]) => void | Promise<void>

/**
 * torno's one local HTTP server. What the agent's CLI talks to lives under a
 * prefix each: its hooks (/hooks), the MCP server (/mcp).
 */
export interface HttpRouter {
  port: number
  /** The address of a path on this server, as the agent is given it. */
  url(path: string): string
  /**
   * Requests whose path is `prefix` or below go to `h`, with the path
   * segments after the prefix, decoded, in `rest`.
   */
  route(prefix: string, h: Handler): void
  close(): Promise<void>
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

/** Listens on 127.0.0.1 only, on a port the system chooses. */
export function startHttp(): Promise<HttpRouter> {
  const routes: { segments: string[]; handler: Handler }[] = []

  const server = createServer((req, res) => {
    let segments: string[]
    try {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      segments = path.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      return sendJson(res, 400, { error: 'bad path' })
    }
    const found = routes.find((r) => r.segments.every((segment, i) => segments[i] === segment))
    if (!found) return sendJson(res, 404, { error: 'not found' })
    Promise.resolve()
      .then(() => found.handler(req, res, segments.slice(found.segments.length)))
      .catch((e: unknown) => {
        console.error(`${req.method} ${req.url}: ${e instanceof Error ? e.message : String(e)}`)
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
        url: (path) => `http://127.0.0.1:${port}${path.startsWith('/') ? path : `/${path}`}`,
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

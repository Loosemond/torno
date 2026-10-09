import { request } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type HttpRouter, sendJson, startHttp } from './http'

let http: HttpRouter
let served = 0

/** A POST with exactly these headers besides the ones Node adds (Host, unless given). */
function post(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: http.port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end('{}')
  })
}

beforeAll(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  http = await startHttp()
  for (const prefix of ['/hooks', '/mcp']) {
    http.route(prefix, (req, res, rest) => {
      served += 1
      req.resume()
      sendJson(res, 200, { rest })
    })
  }
})

afterAll(async () => {
  await http.close()
  vi.restoreAllMocks()
})

describe('the local HTTP server', () => {
  it('serves a request addressed to it as 127.0.0.1 or localhost, with the path below the prefix decoded', async () => {
    expect(await post('/mcp/helmet%20stand', {})).toEqual({ status: 200, body: '{"rest":["helmet stand"]}' })
    expect((await post('/hooks/a/Stop', { host: `localhost:${http.port}` })).status).toBe(200)
  })

  it('refuses a request a web page made: one with an Origin header', async () => {
    served = 0
    for (const path of ['/mcp/bracket', '/hooks/a/Stop', '/nothing']) {
      for (const origin of ['https://example.com', `http://127.0.0.1:${http.port}`, 'null']) {
        const reply = await post(path, { origin })
        expect(reply.status).toBe(403)
        expect(reply.body).toContain('web page')
      }
    }
    expect(served).toBe(0)
  })

  it('refuses a request that names another host: a page rebound to 127.0.0.1', async () => {
    served = 0
    for (const path of ['/mcp/bracket', '/hooks/a/Stop']) {
      for (const host of [`evil.example:${http.port}`, 'evil.example', '127.0.0.1', `127.0.0.1:${http.port + 1}`, `localhost.evil.example:${http.port}`]) {
        const reply = await post(path, { host })
        expect(reply.status).toBe(403)
        expect(reply.body).toContain('Host')
      }
    }
    expect(served).toBe(0)
  })
})

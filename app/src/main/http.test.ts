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

/** The path of an address as the agent is given it: with the run's secret in it. */
const given = (path: string): string => new URL(http.url(path)).pathname
/** The secret of this run, as it stands in an address. */
const secret = (): string => given('/mcp/x').split('/')[2]

describe('the local HTTP server', () => {
  it('serves a request addressed to it as 127.0.0.1 or localhost, with the path below the prefix decoded', async () => {
    expect(await post(given('/mcp/helmet%20stand'), {})).toEqual({ status: 200, body: '{"rest":["helmet stand"]}' })
    expect((await post(given('/hooks/a/Stop'), { host: `localhost:${http.port}` })).status).toBe(200)
  })

  it('gives every address with a secret of this run in it: 32 random bytes, after the prefix', async () => {
    expect(http.url('/mcp/bracket')).toBe(`http://127.0.0.1:${http.port}/mcp/${secret()}/bracket`)
    expect(http.url('hooks/s1/Stop')).toBe(`http://127.0.0.1:${http.port}/hooks/${secret()}/s1/Stop`)
    expect(http.url('/mcp')).toBe(`http://127.0.0.1:${http.port}/mcp/${secret()}`)
    // base64url of 32 bytes: 43 characters that need no escaping in a path.
    expect(secret()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(secret(), 'base64url')).toHaveLength(32)
    const other = await startHttp()
    try {
      expect(new URL(other.url('/mcp/x')).pathname.split('/')[2]).not.toBe(secret())
    } finally {
      await other.close()
    }
  })

  it('answers 404 to whatever does not name the secret, and serves nothing of it', async () => {
    served = 0
    const one = secret()
    const flipped = `${one.slice(0, -1)}${one.endsWith('A') ? 'B' : 'A'}`
    for (const path of [
      '/mcp/bracket',
      '/hooks/a/Stop',
      '/mcp',
      '/hooks',
      `/mcp/${flipped}/bracket`,
      `/mcp/${one.slice(0, 20)}/bracket`,
      `/mcp/${one}x/bracket`,
      `/mcp/${one.toLowerCase() === one ? one.toUpperCase() : one.toLowerCase()}/bracket`,
      // The secret is the segment after the prefix, and nowhere else.
      `/mcp/bracket/${one}`,
      `/${one}/mcp/bracket`,
      `/mcp/bracket?token=${one}`,
      `/hooks/${flipped}/a/Stop`
    ]) {
      expect([path, await post(path, {})]).toEqual([path, { status: 404, body: '{"error":"not found"}' }])
    }
    expect(served).toBe(0)
    // And with it, what is not routed is not found either.
    expect((await post(given('/nothing/here'), {})).status).toBe(404)
  })

  it('never writes the secret in what it logs, and takes it out of a text it is asked to', async () => {
    const logged = vi.mocked(console.error)
    logged.mockClear()
    http.route('/broken', () => {
      throw new Error('it broke')
    })
    expect((await post(given('/broken/x'), {})).status).toBe(500)
    expect((await post(given('/mcp/bracket'), { origin: 'https://example.com' })).status).toBe(403)
    expect(logged.mock.calls.length).toBe(2)
    for (const call of logged.mock.calls) {
      expect(call.join(' ')).not.toContain(secret())
      expect(call.join(' ')).toContain('<secret>')
    }
    expect(http.redact(`["--mcp-config","{\\"url\\":\\"${http.url('/mcp/bracket')}\\"}"]`)).toBe(`["--mcp-config","{\\"url\\":\\"http://127.0.0.1:${http.port}/mcp/<secret>/bracket\\"}"]`)
  })

  it('refuses a request a web page made: one with an Origin header', async () => {
    served = 0
    for (const path of ['/mcp/bracket', '/hooks/a/Stop', '/nothing']) {
      for (const origin of ['https://example.com', `http://127.0.0.1:${http.port}`, 'null']) {
        const reply = await post(given(path), { origin })
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
        const reply = await post(given(path), { host })
        expect(reply.status).toBe(403)
        expect(reply.body).toContain('Host')
      }
    }
    expect(served).toBe(0)
  })
})

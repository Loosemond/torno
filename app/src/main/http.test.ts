import { request } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type HttpRouter, sendJson, SESSION_HEADER, startHttp } from './http'

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

/** The path of an address as the agent is given it. */
const given = (path: string): string => new URL(http.url(path)).pathname
/** A token that opens what is below `/mcp/bracket` and `/hooks/a`, as a session of `bracket` has. */
let token: string
const sent = (value: string = token): Record<string, string> => ({ [SESSION_HEADER]: value })

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
  token = http.grant(['/mcp/bracket', '/hooks/a'])
})

afterAll(async () => {
  await http.close()
  vi.restoreAllMocks()
})

describe('the local HTTP server', () => {
  it('serves a request addressed to it as 127.0.0.1 or localhost, with the path below the prefix decoded', async () => {
    const stand = http.grant(['/mcp/helmet%20stand'])
    expect(await post(given('/mcp/helmet%20stand'), sent(stand))).toEqual({ status: 200, body: '{"rest":["helmet stand"]}' })
    expect((await post(given('/hooks/a/Stop'), { ...sent(), host: `localhost:${http.port}` })).status).toBe(200)
  })

  it('gives every address with no secret in it: the port and the path', () => {
    expect(http.url('/mcp/bracket')).toBe(`http://127.0.0.1:${http.port}/mcp/bracket`)
    expect(http.url('hooks/s1/Stop')).toBe(`http://127.0.0.1:${http.port}/hooks/s1/Stop`)
  })

  it('makes a token of 32 random bytes each time it is asked, as base64url', () => {
    // base64url of 32 bytes: 43 characters that need no escaping in a header.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(http.grant(['/mcp/bracket'])).not.toBe(token)
  })

  it('answers 404 to a request without the token of what it asks for in its header, and serves nothing of it', async () => {
    served = 0
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`
    const elsewhere = http.grant(['/mcp/other', '/hooks/b'])
    const cases: Array<[string, Record<string, string>]> = [
      ['/mcp/bracket', {}],
      ['/hooks/a/Stop', {}],
      ['/mcp/bracket', sent('')],
      // What Claude Code sends should it not expand the placeholder: the placeholder itself.
      ['/mcp/bracket', sent('${TORNO_SESSION}')],
      ['/hooks/a/Stop', sent('$TORNO_SESSION')],
      ['/mcp/bracket', sent(flipped)],
      ['/mcp/bracket', sent(token.slice(0, 20))],
      ['/mcp/bracket', sent(`${token}x`)],
      ['/mcp/bracket', sent(token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase())],
      ['/mcp/bracket', { authorization: `Bearer ${token}` }],
      // Another session's token: of another object, or for another session's hooks.
      ['/mcp/bracket', sent(elsewhere)],
      ['/hooks/a/Stop', sent(elsewhere)],
      ['/mcp/other', sent()],
      ['/hooks/b/Stop', sent()],
      // What a token opens is what is below its paths, segment by segment.
      ['/mcp/bracketx', sent()],
      ['/mcp', sent()],
      ['/hooks', sent()],
      ['/hooks/ab/Stop', sent()],
      // The token is in the header, and nowhere else.
      [`/mcp/bracket?token=${token}`, {}],
      [`/mcp/${token}/bracket`, {}],
      [`/mcp/bracket/${token}`, {}]
    ]
    for (const [path, headers] of cases) {
      expect([path, headers, await post(path, headers)]).toEqual([path, headers, { status: 404, body: '{"error":"not found"}' }])
    }
    expect(served).toBe(0)
    // And with it, what is not routed is not found either.
    const nothing = http.grant(['/nothing'])
    expect((await post(given('/nothing/here'), sent(nothing))).status).toBe(404)
  })

  it('opens what is below the paths a token was made for, until it is revoked', async () => {
    const own = http.grant(['/mcp/lid', '/hooks/s2'])
    expect((await post(given('/mcp/lid'), sent(own))).status).toBe(200)
    expect((await post(given('/hooks/s2/Stop'), sent(own))).status).toBe(200)
    http.revoke(own)
    served = 0
    expect((await post(given('/mcp/lid'), sent(own))).status).toBe(404)
    expect((await post(given('/hooks/s2/Stop'), sent(own))).status).toBe(404)
    expect(served).toBe(0)
    // The others are as they were.
    expect((await post(given('/mcp/bracket'), sent())).status).toBe(200)
  })

  it('never writes a token in what it logs, and takes every token it made out of a text it is asked to', async () => {
    const logged = vi.mocked(console.error)
    logged.mockClear()
    const broken = http.grant(['/broken'])
    http.route('/broken', () => {
      throw new Error(`it broke with ${broken}`)
    })
    expect((await post(given('/broken/x'), sent(broken))).status).toBe(500)
    expect((await post(given('/mcp/bracket'), { ...sent(), origin: 'https://example.com' })).status).toBe(403)
    expect(logged.mock.calls.length).toBe(2)
    for (const call of logged.mock.calls) {
      expect(call.join(' ')).not.toContain(token)
      expect(call.join(' ')).not.toContain(broken)
    }
    expect(logged.mock.calls[0].join(' ')).toContain('<secret>')
    expect(http.redact(`TORNO_SESSION=${token} and ${broken}`)).toBe('TORNO_SESSION=<secret> and <secret>')
    // One revoked is still taken out: it may be in what is logged after its session ended.
    const gone = http.grant(['/mcp/gone'])
    http.revoke(gone)
    expect(http.redact(`was ${gone}`)).toBe('was <secret>')
  })

  it('refuses a request a web page made: one with an Origin header', async () => {
    served = 0
    for (const path of ['/mcp/bracket', '/hooks/a/Stop', '/nothing']) {
      for (const origin of ['https://example.com', `http://127.0.0.1:${http.port}`, 'null']) {
        const reply = await post(given(path), { ...sent(), origin })
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
        const reply = await post(given(path), { ...sent(), host })
        expect(reply.status).toBe(403)
        expect(reply.body).toContain('Host')
      }
    }
    expect(served).toBe(0)
  })
})

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Part } from '../../shared/scene'
import type { LookRequest } from '../../shared/view'
import { type HttpRouter, startHttp } from '../http'
import { mountMcp } from './server'
import type { ToolDeps } from './tools'

// The MCP server as an agent's CLI meets it: the SDK's client over HTTP, a real
// HttpRouter, and stand-ins for what torno knows.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7])
const BASE = { key: 'main:base', name: 'base', layout: 'main', bbox: { min: [0, 0, 0], max: [40, 30, 5] }, volume: 6000, faceCount: 6, edgeCount: 12, valid: true } as Part

let http: HttpRouter
let looks: Array<{ objectId: string; req: LookRequest }> = []
let release: (() => void) | null = null
const clients: Client[] = []

const deps: ToolDeps = {
  object: (id) => (id === 'bracket' ? { id, name: id, dir: '/ws/bracket', model: 'bracket.py' } : undefined),
  build: (id) => (id === 'bracket' ? { objectId: id, status: 'ok', revision: 2, seconds: 0.5, stale: false } : undefined),
  scene: (id) => (id === 'bracket' ? { revision: 2, scene: { model: 'bracket.py', layouts: ['main'], parts: [BASE], seconds: 0.5, output: '' } } : undefined),
  view: () => undefined,
  openObjectId: () => 'bracket',
  look: async (objectId, req) => {
    looks.push({ objectId, req })
    // Held back when a test wants two requests under way at once.
    if (req.view === 'top') await new Promise<void>((resolve) => (release = resolve))
    return { png: PNG, width: 4, height: 3, caption: `view ${String(req.view)}`, objectId, revision: 2, stale: false }
  },
  saveImage: async () => '/ws/bracket/.torno/views/1.png'
}

async function connect(objectId: string): Promise<Client> {
  const client = new Client({ name: 'torno-test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url(`/mcp/${encodeURIComponent(objectId)}`))))
  clients.push(client)
  return client
}

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>

beforeAll(async () => {
  http = await startHttp()
  mountMcp(http, deps)
})

afterEach(async () => {
  looks = []
  release = null
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

afterAll(() => http.close())

describe('the MCP server', () => {
  it('lists scene and look, each with a description', async () => {
    const client = await connect('bracket')
    expect(client.getServerVersion()?.name).toBe('torno')
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['look', 'scene'])
    for (const tool of tools) expect(tool.description).toMatch(/^Returns /)
    const look = tools.find((t) => t.name === 'look')!
    expect(Object.keys(look.inputSchema.properties ?? {}).sort()).toEqual(['layout', 'parts', 'size', 'view'])
    expect(look.inputSchema.required ?? []).toEqual([])
  })

  it('answers scene with JSON of the object named in the address', async () => {
    const client = await connect('bracket')
    const result = await client.callTool({ name: 'scene', arguments: {} })
    expect(result.isError).toBeFalsy()
    const scene = JSON.parse((result.content as Content)[0].text!)
    expect(scene).toMatchObject({ object: 'bracket', build: { status: 'ok', revision: 2 }, parts: [{ name: 'base', size: [40, 30, 5] }] })
  })

  it('answers look with an image block holding the very bytes of the picture', async () => {
    const client = await connect('bracket')
    const result = await client.callTool({ name: 'look', arguments: { view: 'iso', size: 5000 } })
    expect(result.isError).toBeFalsy()
    const [image, text] = result.content as Content
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(new Uint8Array(Buffer.from(image.data!, 'base64'))).toEqual(PNG)
    expect(text.text).toBe('view iso\nrevision r2\nsaved as /ws/bracket/.torno/views/1.png')
    expect(looks).toEqual([{ objectId: 'bracket', req: { view: 'iso', size: 2000 } }])
  })

  it('refuses arguments that are not what look takes', async () => {
    const client = await connect('bracket')
    const result = await client.callTool({ name: 'look', arguments: { view: 'sideways' } }).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }))
    expect(result.isError).toBe(true)
    expect((result.content as Content)[0].text).toMatch(/view/)
    expect(looks).toEqual([])
  })

  it('serves a second client while the first is waiting', async () => {
    const first = await connect('bracket')
    const second = await connect('bracket')
    const slow = first.callTool({ name: 'look', arguments: { view: 'top' } })
    await vi.waitFor(() => expect(release).not.toBeNull())
    const quick = await second.callTool({ name: 'look', arguments: { view: 'front' } })
    expect((quick.content as Content)[1].text).toContain('view front')
    expect((await second.listTools()).tools).toHaveLength(2)
    release!()
    expect(((await slow).content as Content)[1].text).toContain('view top')
  })

  it('answers GET and DELETE with 405', async () => {
    for (const method of ['GET', 'DELETE']) {
      const reply = await fetch(http.url('/mcp/bracket'), { method, headers: { accept: 'text/event-stream' } })
      expect(reply.status).toBe(405)
      expect(reply.headers.get('allow')).toBe('POST')
      expect(await reply.json()).toMatchObject({ jsonrpc: '2.0', error: { message: expect.stringContaining('POST only') } })
    }
  })

  it('answers a body that is not JSON with 400, and an address without an object with 404', async () => {
    const bad = await fetch(http.url('/mcp/bracket'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    expect(bad.status).toBe(400)
    const nowhere = await fetch(http.url('/mcp'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(nowhere.status).toBe(404)
  })

  it('serves an object id the workspace does not have, whose tools say so', async () => {
    const client = await connect('no such')
    expect((await client.listTools()).tools).toHaveLength(2)
    for (const name of ['scene', 'look']) {
      const result = await client.callTool({ name, arguments: {} })
      expect(result.isError).toBe(true)
      expect((result.content as Content)[0].text).toBe('unknown object: no such')
    }
  })
})

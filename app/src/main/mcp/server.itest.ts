import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Mark, NewMark } from '../../shared/marks'
import type { Part } from '../../shared/scene'
import type { LookRequest } from '../../shared/view'
import { type HttpRouter, startHttp } from '../http'
import { mountMcp } from './server'
import type { ToolDeps } from './tools'

// The MCP server as an agent's CLI meets it: the SDK's client over HTTP, a real
// HttpRouter, and stand-ins for what torno knows.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7])
const BASE = { key: 'main:base', name: 'base', layout: 'main', bbox: { min: [0, 0, 0], max: [40, 30, 5] }, volume: 6000, faceCount: 6, edgeCount: 12, valid: true } as Part

const PIN: Mark = {
  id: 'M1',
  kind: 'pin',
  author: 'user',
  note: 'here',
  status: 'draft',
  anchorState: 'ok',
  layout: 'main',
  revision: 2,
  camera: { position: [100, -100, 80], target: [0, 0, 0], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 },
  createdAt: '2026-10-09T12:00:00.000Z',
  anchor: { point: [1, 2, 5], part: 'base', ref: 'base/F5' }
}
let added: NewMark[] = []

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
  saveImage: async () => '/ws/bracket/.torno/views/1.png',
  marks: async () => [PIN],
  addMark: async (_objectId, mark) => {
    added.push(mark)
    return { ...mark, id: 'M2', status: 'sent', anchorState: 'ok', createdAt: PIN.createdAt } as Mark
  },
  updateMark: async (_objectId, id, patch) => {
    if (id !== 'M1') throw new Error(`no mark ${id}; marks: M1`)
    return { ...PIN, ...patch }
  },
  describe: async (_objectId, layout, ref) => ({ kind: 'face', ref: `${layout}:${ref}`, type: 'plane', area: 1200, center: [20, 15, 5], normal: [0, 0, 1], radius: null, descriptor: 'plane, normal +Z, z = 5, 1200 mm²' }),
  nearest: async (_objectId, _layout, anchors) => anchors.map(({ part, point }) => ({ part, found: true, point, normal: [0, 0, 1], ref: `${part}/F5`, distance: 0, descriptor: null })),
  show: async (objectId, req) => ({ caption: `view ${String(req.view)} · layout main`, objectId, revision: 2, stale: false }),
  highlight: async (objectId, layout, refs) => ({ objectId, layout, refs, revision: 2 })
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
  added = []
  release = null
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

afterAll(() => http.close())

const ALL = ['add_mark', 'describe', 'highlight', 'look', 'marks', 'resolve_mark', 'scene', 'show']
/** The least each tool can be called with. */
const MINIMAL: Record<string, Record<string, unknown>> = {
  scene: {},
  look: {},
  marks: {},
  describe: { ref: 'base' },
  highlight: { refs: ['base'] },
  show: { view: 'top' },
  add_mark: { kind: 'pin', note: '', ref: 'base' },
  resolve_mark: { id: 'M1' }
}

describe('the MCP server', () => {
  it('lists the tools, each with a description', async () => {
    const client = await connect('bracket')
    expect(client.getServerVersion()?.name).toBe('torno')
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(ALL)
    const inputs = (name: string) => tools.find((t) => t.name === name)!.inputSchema
    expect(Object.keys(inputs('add_mark').properties ?? {}).sort()).toEqual(['by', 'intent', 'kind', 'layout', 'note', 'point', 'position', 'ref', 'rotation', 'shape', 'size', 'to'])
    expect(inputs('add_mark').required).toEqual(['kind', 'note'])
    expect(inputs('resolve_mark').required).toEqual(['id'])
    expect(inputs('highlight').required).toEqual(['refs'])
    expect(inputs('describe').required).toEqual(['ref'])
    expect(inputs('show').required ?? []).toEqual([])
    expect(inputs('marks').required ?? []).toEqual([])
    for (const tool of tools) expect(tool.description).toMatch(/^Returns /)
    const look = tools.find((t) => t.name === 'look')!
    expect(Object.keys(look.inputSchema.properties ?? {}).sort()).toEqual(['layout', 'marks', 'parts', 'size', 'view'])
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

  it("answers the tools that read and write marks, point things out and change the user's view", async () => {
    const client = await connect('bracket')
    const text = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError, `${name}: ${(result.content as Content)[0].text}`).toBeFalsy()
      return (result.content as Content)[0].text!
    }
    const line = 'M1 pin on base/F5 at (1, 2, 5): "here"'
    expect(JSON.parse(await text('marks', { status: 'draft' }))).toEqual([{ ...PIN, line }])
    expect(JSON.parse(await text('describe', { ref: 'base/F5' }))).toMatchObject({ layout: 'main', kind: 'face', ref: 'main:base/F5', descriptor: 'plane, normal +Z, z = 5, 1200 mm²' })
    expect(JSON.parse(await text('describe', { ref: 'M1' }))).toEqual({ ...PIN, line })
    expect(await text('highlight', { refs: ['base/F5', 'M1'], note: 'this one?' })).toBe('highlighted base/F5 in layout main for the user, with the note "this one?", until they click in the viewport or 60 s pass.')
    expect(await text('show', { view: 'top' })).toBe("view top · layout main\nrevision r2\nThe user's viewport now shows this.")
    expect(await text('add_mark', { kind: 'pin', note: 'this face?', ref: 'base/F5' })).toBe('placed in layout main: (yours) M2 pin on base/F5 (plane, normal +Z, z = 5, 1200 mm²) at (20, 15, 5): "this face?"')
    expect(added).toMatchObject([{ kind: 'pin', author: 'agent', anchor: { ref: 'base/F5' } }])
    expect(await text('resolve_mark', { id: 'M1', note: 'done' })).toBe('resolved: M1 pin on base/F5 at (1, 2, 5): "here"\nnote: done')
    const missing = await client.callTool({ name: 'resolve_mark', arguments: { id: 'M7' } })
    expect(missing).toMatchObject({ isError: true, content: [{ text: 'no mark M7; marks: M1' }] })
  })

  it('refuses arguments that are not what the new tools take', async () => {
    const client = await connect('bracket')
    const bad: Array<[string, Record<string, unknown>]> = [
      ['add_mark', { kind: 'dimension', note: '' }],
      ['add_mark', { kind: 'pin', note: '', point: [1, 2] }],
      ['highlight', { refs: [] }],
      ['show', { view: 'current' }],
      ['marks', { status: 'done' }]
    ]
    for (const [name, args] of bad) {
      const result = await client.callTool({ name, arguments: args }).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }))
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true)
    }
    expect(added).toEqual([])
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
    expect((await second.listTools()).tools).toHaveLength(ALL.length)
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
    expect((await client.listTools()).tools).toHaveLength(ALL.length)
    for (const [name, args] of Object.entries(MINIMAL)) {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError).toBe(true)
      expect((result.content as Content)[0].text).toBe('unknown object: no such')
    }
  })
})

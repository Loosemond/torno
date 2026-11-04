import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Part } from '../shared/scene'
import { type Door, openDoor } from './door'
import { type HttpRouter, startHttp } from './http'
import { SERVER_INSTRUCTIONS } from './mcp/schemas'
import { mountMcp } from './mcp/server'
import type { ToolDeps } from './mcp/tools'

// The second door end to end: a fake MCP client (the SDK's, over stdio) runs the bridge, which reaches the MCP server
// through the socket. No agent CLI is run.
const BRIDGE = resolve(__dirname, '../../../scripts/torno-mcp.mjs')
const BASE = { key: 'main:base', name: 'base', layout: 'main', bbox: { min: [0, 0, 0], max: [40, 30, 5] }, volume: 6000, faceCount: 6, edgeCount: 12, valid: true } as Part

const work = mkdtempSync(join(tmpdir(), 'torno-door-'))
const runtime = join(work, 'run')
const project = join(work, 'ws', 'bracket')
mkdirSync(project, { recursive: true })

const deps = {
  object: (id: string) => (id === 'bracket' ? { id, name: id, dir: project, model: 'bracket.py' } : undefined),
  build: (id: string) => (id === 'bracket' ? { objectId: id, status: 'ok', revision: 2, seconds: 0.5, stale: false } : undefined),
  scene: (id: string) => (id === 'bracket' ? { revision: 2, scene: { model: 'bracket.py', layouts: ['main'], parts: [BASE], seconds: 0.5, output: '' } } : undefined),
  view: () => undefined,
  openObjectId: () => 'bracket',
  marks: async () => [],
  views: async () => [],
  scans: async () => [],
  scansBusy: () => [],
  scanPaths: () => undefined
} as unknown as ToolDeps

let http: HttpRouter
let door: Door
let answer = true
const asked: Array<{ objectId: string; client: string; pid: number | null }> = []
const revoked: string[] = []
const clients: Client[] = []

async function bridge(folder = project, dir = runtime): Promise<Client> {
  const client = new Client({ name: 'fake-agent', version: '0' })
  clients.push(client)
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BRIDGE, folder], env: { PATH: process.env.PATH ?? '', XDG_RUNTIME_DIR: dir } }))
  return client
}

beforeAll(async () => {
  http = await startHttp()
  const revoke = http.revoke
  http.revoke = (token) => (revoked.push(token), revoke(token))
  mountMcp(http, deps)
  door = await openDoor(
    {
      http,
      objectFor: (folder) => (folder === project ? { id: 'bracket', name: 'bracket' } : undefined),
      approve: async (ask) => (asked.push(ask), answer)
    },
    join(runtime, 'torno')
  )
})

afterEach(async () => {
  answer = true
  asked.length = 0
  await Promise.all(clients.splice(0).map((c) => c.close()))
})

afterAll(async () => {
  await door.close()
  await http.close()
  rmSync(work, { recursive: true, force: true })
})

describe('the door for an agent torno did not start', () => {
  it('is a socket only the person may open, and nothing else is written', () => {
    expect(statSync(join(runtime, 'torno')).mode & 0o777).toBe(0o700)
    expect(statSync(door.path).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(runtime, 'torno'))).toEqual(['door.sock'])
  })

  it('serves the tools once the person allows it, with the instructions', async () => {
    const client = await bridge()
    expect(asked).toEqual([{ objectId: 'bracket', name: 'bracket', client: expect.any(String), pid: expect.any(Number) }])
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS)
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toContain('scene')
    const scene = await client.callTool({ name: 'scene', arguments: {} })
    expect(JSON.stringify(scene.content)).toContain('base')
  })

  it('takes the token back when the client goes', async () => {
    const before = revoked.length
    const client = await bridge()
    await client.close()
    await new Promise((r) => setTimeout(r, 200))
    expect(revoked.length).toBe(before + 1)
  })

  it('answers nothing when the person says no', async () => {
    answer = false
    await expect(bridge()).rejects.toThrow(/did not allow/)
  })

  it('asks nothing for a folder that is no project of the workspace', async () => {
    await expect(bridge(work)).rejects.toThrow(/no project of the workspace/)
    expect(asked).toEqual([])
  })

  it('says how to start torno when it is not running', async () => {
    await expect(bridge(project, join(work, 'none'))).rejects.toThrow(/torno is not running/)
  })
})

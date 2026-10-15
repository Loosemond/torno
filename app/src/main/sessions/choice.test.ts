import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { adapters } from './adapter'
import { installedAgents, readChoice, writeChoice } from './choice'

it('keeps the agent of an object in .torno/agent.json, and is Claude Code for anything else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'torno-choice-'))
  expect((await readChoice(dir)).agent).toBe('claude')
  await writeChoice(dir, { agent: 'copilot', view: 'terminal' })
  expect(JSON.parse(await readFile(join(dir, '.torno', 'agent.json'), 'utf8'))).toEqual({ agent: 'copilot', view: 'terminal' })
  expect((await readChoice(dir)).agent).toBe('copilot')
  for (const text of ['{ not json', '{"agent":"gemini"}', '[]', '{"agent":7}']) {
    await mkdir(join(dir, '.torno'), { recursive: true })
    await writeFile(join(dir, '.torno', 'agent.json'), text)
    expect((await readChoice(dir)).agent).toBe('claude')
  }
})

it('says so when the file names an agent it does not know, and writes nothing but the file, whole', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'torno-choice-'))
  expect(await readChoice(dir)).toEqual({ agent: 'claude', view: 'chat' })
  await mkdir(join(dir, '.torno'), { recursive: true })
  await writeFile(join(dir, '.torno', 'agent.json'), '{"agent":"gemini"}')
  expect(await readChoice(dir)).toEqual({ agent: 'claude', view: 'chat', note: 'agent.json names "gemini", which torno does not know: Claude Code is used.' })
  // What is named is the person's file's word: told short, and with no control character in it.
  await writeFile(join(dir, '.torno', 'agent.json'), JSON.stringify({ agent: `a\u001b[31m${'x'.repeat(200)}` }))
  const told = (await readChoice(dir)).note!
  expect(told).not.toMatch(/[\u0000-\u001f]/)
  expect(told.length).toBeLessThan(120)
  await writeFile(join(dir, '.torno', 'agent.json'), '{ not json')
  expect(await readChoice(dir)).toEqual({ agent: 'claude', view: 'chat', note: 'agent.json could not be read: Claude Code is used.' })
  await writeChoice(dir, { agent: 'claude', view: 'chat' })
  expect(await readChoice(dir)).toEqual({ agent: 'claude', view: 'chat' })
  expect(await readdir(join(dir, '.torno'))).toEqual(['agent.json'])
  // Never an agent that is not one, whatever asks.
  await expect(writeChoice(dir, { agent: 'gemini' as never, view: 'chat' })).rejects.toThrow('no agent named gemini')
})

it('chooses a view: Claude Code is in chat unless the file says terminal, Copilot CLI is always in a terminal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'torno-choice-'))
  await mkdir(join(dir, '.torno'), { recursive: true })
  const file = join(dir, '.torno', 'agent.json')
  expect(await readChoice(dir)).toEqual({ agent: 'claude', view: 'chat' })
  await writeFile(file, '{"agent":"claude"}')
  expect(await readChoice(dir)).toEqual({ agent: 'claude', view: 'chat' })
  await writeFile(file, '{"agent":"claude","view":"terminal"}')
  expect(await readChoice(dir)).toEqual({ agent: 'claude', view: 'terminal' })
  await writeFile(file, '{"agent":"copilot","view":"chat"}')
  expect(await readChoice(dir)).toEqual({ agent: 'copilot', view: 'terminal' })
  await writeFile(file, '{"agent":"claude","view":"split"}')
  expect(await readChoice(dir)).toEqual({ agent: 'claude', view: 'chat', note: 'agent.json names the view "split", which torno does not know: chat is used.' })
})

it('writes the choice whole, keeps the view when only the agent is chosen, and refuses a view that is none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'torno-choice-'))
  await writeChoice(dir, { agent: 'claude', view: 'terminal' })
  // Only the agent chosen: the view the file holds stays, also through an agent that has no chat.
  await writeChoice(dir, { agent: 'copilot' })
  expect(JSON.parse(await readFile(join(dir, '.torno', 'agent.json'), 'utf8'))).toEqual({ agent: 'copilot', view: 'terminal' })
  await writeChoice(dir, { agent: 'claude', view: 'chat' })
  await writeChoice(dir, { agent: 'copilot' })
  await writeChoice(dir, { agent: 'claude' })
  expect(await readChoice(dir)).toEqual({ agent: 'claude', view: 'chat' })
  await expect(writeChoice(dir, { agent: 'claude', view: 'split' as never })).rejects.toThrow('no view named split')
  expect(await readdir(join(dir, '.torno'))).toEqual(['agent.json'])
})

it('finds which agents are installed: the command of each on PATH, or the one that stands in for all', () => {
  const bin = mkdtempSync(join(tmpdir(), 'torno bin '))
  writeFileSync(join(bin, 'copilot'), '#!/bin/sh\n')
  chmodSync(join(bin, 'copilot'), 0o755)
  // A folder of that name is not a command, nor a file that cannot be run.
  mkdirSync(join(bin, 'other'))
  mkdirSync(join(bin, 'other', 'claude'))
  writeFileSync(join(bin, 'claude'), '')
  expect(installedAgents(adapters(), `${join(bin, 'other')}:${bin}`)).toEqual([
    { id: 'claude', label: 'Claude Code', installed: false, hooks: true },
    { id: 'copilot', label: 'Copilot CLI', installed: true, hooks: false }
  ])
  expect(installedAgents(adapters(), '').map((a) => a.installed)).toEqual([false, false])
  // TORNO_AGENT_CMD is run in place of each: they are there when it is.
  expect(installedAgents(adapters(), '', `${process.execPath} /x/fake-agent.mjs`).map((a) => a.installed)).toEqual([true, true])
  expect(installedAgents(adapters(), bin, 'torno-no-such-agent').map((a) => a.installed)).toEqual([false, false])
})

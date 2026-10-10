import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { adapters } from './adapter'
import { installedAgents, loadAgentChoice, readAgentChoice, saveAgentChoice } from './choice'

it('keeps the agent of an object in .torno/agent.json, and is Claude Code for anything else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'torno-choice-'))
  expect(await loadAgentChoice(dir)).toBe('claude')
  await saveAgentChoice(dir, 'copilot')
  expect(JSON.parse(await readFile(join(dir, '.torno', 'agent.json'), 'utf8'))).toEqual({ agent: 'copilot' })
  expect(await loadAgentChoice(dir)).toBe('copilot')
  for (const text of ['{ not json', '{"agent":"gemini"}', '[]', '{"agent":7}']) {
    await mkdir(join(dir, '.torno'), { recursive: true })
    await writeFile(join(dir, '.torno', 'agent.json'), text)
    expect(await loadAgentChoice(dir)).toBe('claude')
  }
})

it('says so when the file names an agent it does not know, and writes nothing but the file, whole', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'torno-choice-'))
  expect(await readAgentChoice(dir)).toEqual({ agent: 'claude' })
  await mkdir(join(dir, '.torno'), { recursive: true })
  await writeFile(join(dir, '.torno', 'agent.json'), '{"agent":"gemini"}')
  expect(await readAgentChoice(dir)).toEqual({ agent: 'claude', note: 'agent.json names "gemini", which torno does not know: Claude Code is used.' })
  // What is named is the person's file's word: told short, and with no control character in it.
  await writeFile(join(dir, '.torno', 'agent.json'), JSON.stringify({ agent: `a\u001b[31m${'x'.repeat(200)}` }))
  const told = (await readAgentChoice(dir)).note!
  expect(told).not.toMatch(/[\u0000-\u001f]/)
  expect(told.length).toBeLessThan(120)
  await writeFile(join(dir, '.torno', 'agent.json'), '{ not json')
  expect(await readAgentChoice(dir)).toEqual({ agent: 'claude', note: 'agent.json could not be read: Claude Code is used.' })
  await saveAgentChoice(dir, 'claude')
  expect(await readAgentChoice(dir)).toEqual({ agent: 'claude' })
  expect(await readdir(join(dir, '.torno'))).toEqual(['agent.json'])
  // Never an agent that is not one, whatever asks.
  await expect(saveAgentChoice(dir, 'gemini' as never)).rejects.toThrow('no agent named gemini')
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

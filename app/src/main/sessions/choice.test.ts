import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { findCommand, readChoice, writeChoice } from './choice'

it('keeps the view of an object in .torno/agent.json, with Claude Code named, and is the chat for anything else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'torno-choice-'))
  expect(await readChoice(dir)).toEqual({ view: 'chat' })
  await writeChoice(dir, 'terminal')
  // Named as an older torno names it: a file of this torno is one that torno reads too.
  expect(JSON.parse(await readFile(join(dir, '.torno', 'agent.json'), 'utf8'))).toEqual({ agent: 'claude', view: 'terminal' })
  expect(await readChoice(dir)).toEqual({ view: 'terminal' })
  await writeChoice(dir, 'chat')
  expect(await readChoice(dir)).toEqual({ view: 'chat' })
  for (const text of ['{ not json', '{"agent":"gemini","view":"terminal"}', '[]', '{"agent":7}']) {
    await writeFile(join(dir, '.torno', 'agent.json'), text)
    expect((await readChoice(dir)).view).toBe('chat')
  }
  expect(await readdir(join(dir, '.torno'))).toEqual(['agent.json'])
  // Never a view that is not one, whatever asks.
  await expect(writeChoice(dir, 'split' as never)).rejects.toThrow('no view named split')
})

it('says so when the file names an agent torno no longer runs or does not know, or a view it does not know', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'torno-choice-'))
  await mkdir(join(dir, '.torno'), { recursive: true })
  const file = join(dir, '.torno', 'agent.json')
  // As the torno that ran Copilot CLI wrote it: its view was that agent's, and is not taken for Claude Code's.
  await writeFile(file, '{"agent":"copilot","view":"terminal"}')
  expect(await readChoice(dir)).toEqual({ view: 'chat', note: 'agent.json names Copilot CLI, which torno no longer supports: Claude Code is used.' })
  await writeFile(file, '{"agent":"gemini"}')
  expect(await readChoice(dir)).toEqual({ view: 'chat', note: 'agent.json names "gemini", which torno does not know: Claude Code is used.' })
  // What is named is the person's file's word: told short, and with no control character in it.
  await writeFile(file, JSON.stringify({ agent: `a\u001b[31m${'x'.repeat(200)}` }))
  const told = (await readChoice(dir)).note!
  expect(told).not.toMatch(/[\u0000-\u001f]/)
  expect(told.length).toBeLessThan(120)
  await writeFile(file, '{ not json')
  expect(await readChoice(dir)).toEqual({ view: 'chat', note: 'agent.json could not be read: Claude Code is used.' })
  await writeFile(file, '{"agent":"claude"}')
  expect(await readChoice(dir)).toEqual({ view: 'chat' })
  await writeFile(file, '{"agent":"claude","view":"split"}')
  expect(await readChoice(dir)).toEqual({ view: 'chat', note: 'agent.json names the view "split", which torno does not know: chat is used.' })
  // Writing the choice is what puts it right.
  await writeChoice(dir, 'chat')
  expect(await readChoice(dir)).toEqual({ view: 'chat' })
})

it('finds a command: itself when it is a path, else the first file on PATH that can be run', () => {
  const bin = mkdtempSync(join(tmpdir(), 'torno bin '))
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n')
  chmodSync(join(bin, 'claude'), 0o755)
  // A folder of that name is not a command, nor a file that cannot be run.
  mkdirSync(join(bin, 'other'))
  mkdirSync(join(bin, 'other', 'claude'))
  writeFileSync(join(bin, 'other', 'plain'), '')
  expect(findCommand('claude', `${join(bin, 'other')}:${bin}`)).toBe(join(bin, 'claude'))
  expect(findCommand('plain', `${join(bin, 'other')}:${bin}`)).toBeNull()
  expect(findCommand('claude', '')).toBeNull()
  expect(findCommand(join(bin, 'claude'))).toBe(join(bin, 'claude'))
  expect(findCommand(process.execPath)).toBe(process.execPath)
})

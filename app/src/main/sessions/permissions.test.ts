import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sessionRules } from './permissions'

// What the CLI really suggested for a Bash request (app/test/fixtures/claude-stream-asks.jsonl, Claude Code 2.1.301):
// a rule for the settings of the folder, a directory, and a mode. Only the first is allowed, and only for the session.
const ASK = readFileSync(join(__dirname, '../../../test/fixtures/claude-stream-asks.jsonl'), 'utf8')
  .split('\n')
  .flatMap((line) => {
    try {
      return [JSON.parse(line) as { type?: string; request?: { subtype?: string; tool_name?: string; permission_suggestions?: unknown[] } }]
    } catch {
      return []
    }
  })
  .find((m) => m.type === 'control_request' && m.request?.tool_name === 'Bash')!.request!

it('keeps the rules of the real suggestions, for the session, and drops every other kind', () => {
  expect(ASK.permission_suggestions).toHaveLength(3)
  expect(sessionRules(ASK.permission_suggestions)).toEqual([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch made.txt && ls' }], behavior: 'allow', destination: 'session' }])
})

it('offers nothing when there is no rule to add, and survives what is not a suggestion', () => {
  expect(sessionRules([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }, { type: 'addDirectories', directories: ['/x'], destination: 'session' }])).toEqual([])
  expect(sessionRules([null, 3, 'x', { type: 'addRules' }, { type: 'addRules', rules: 'x' }, { type: 'addRules', rules: [] }])).toEqual([])
  expect(sessionRules(undefined)).toEqual([])
})

it('does not change what it was given', () => {
  const given = [{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'userSettings' }]
  sessionRules(given)
  expect(given[0].destination).toBe('userSettings')
})

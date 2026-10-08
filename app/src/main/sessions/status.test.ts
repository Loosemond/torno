import { describe, expect, it } from 'vitest'
import type { SessionStatus } from '../../shared/bridge'
import { reduceStatus } from './status'

const ALL: SessionStatus[] = ['starting', 'idle', 'working', 'needs_input', 'exited']

describe('reduceStatus', () => {
  it('follows the hooks', () => {
    expect(reduceStatus('idle', 'UserPromptSubmit')).toBe('working')
    expect(reduceStatus('working', 'Stop')).toBe('idle')
    expect(reduceStatus('working', 'Notification')).toBe('needs_input')
    expect(reduceStatus('working', 'PermissionRequest')).toBe('needs_input')
    expect(reduceStatus('needs_input', 'UserPromptSubmit')).toBe('working')
    expect(reduceStatus('needs_input', 'Stop')).toBe('idle')
    expect(reduceStatus('idle', 'SessionEnd')).toBe('exited')
  })

  it('is idle from the first output, and only from the first', () => {
    expect(reduceStatus('starting', 'output')).toBe('idle')
    for (const status of ALL.filter((s) => s !== 'starting')) expect(reduceStatus(status, 'output')).toBe(status)
  })

  it('has exited when the process has, whatever it was doing', () => {
    for (const status of ALL) expect(reduceStatus(status, 'exit')).toBe('exited')
  })

  it('stays exited', () => {
    for (const event of ['output', 'UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest', 'SessionEnd']) {
      expect(reduceStatus('exited', event)).toBe('exited')
    }
  })

  it('is left unchanged by an event it does not know', () => {
    for (const status of ALL) {
      expect(reduceStatus(status, 'PreToolUse')).toBe(status)
      expect(reduceStatus(status, '')).toBe(status)
      expect(reduceStatus(status, 'toString')).toBe(status)
    }
  })
})

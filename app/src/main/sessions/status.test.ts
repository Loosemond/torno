import { describe, expect, it } from 'vitest'
import type { SessionStatus } from '../../shared/bridge'
import { reduceStatus, sessionOfWorkspace } from './status'

const ALL: SessionStatus[] = ['starting', 'idle', 'working', 'needs_input', 'exited']

describe('reduceStatus', () => {
  it('follows the hooks', () => {
    expect(reduceStatus('idle', 'UserPromptSubmit')).toBe('working')
    expect(reduceStatus('working', 'Stop')).toBe('idle')
    expect(reduceStatus('working', 'Notification')).toBe('needs_input')
    // Seen with the real CLI: a Notification is also posted when it has only been idle for a while, which is no question.
    expect(reduceStatus('idle', 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })).toBe('idle')
    expect(reduceStatus('idle', 'Notification', { message: 'Claude is waiting for your input' })).toBe('idle')
    expect(reduceStatus('idle', 'Notification', { notification_type: 'auth_success', message: 'Signed in' })).toBe('idle')
    expect(reduceStatus('working', 'Notification', { notification_type: 'idle_prompt' })).toBe('working')
    // One that is a question, or says nothing of its kind, still is.
    expect(reduceStatus('working', 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })).toBe('needs_input')
    expect(reduceStatus('working', 'Notification', { notification_type: 'elicitation_dialog' })).toBe('needs_input')
    expect(reduceStatus('working', 'Notification', { message: 'Claude needs your permission to use Bash' })).toBe('needs_input')
    expect(reduceStatus('working', 'Notification', 'not an object')).toBe('needs_input')
    expect(reduceStatus('working', 'PermissionRequest')).toBe('needs_input')
    expect(reduceStatus('needs_input', 'UserPromptSubmit')).toBe('working')
    expect(reduceStatus('needs_input', 'Stop')).toBe('idle')
    expect(reduceStatus('idle', 'SessionEnd')).toBe('exited')
  })

  it('is working again once a tool runs: a permission prompt was answered', () => {
    expect(reduceStatus('needs_input', 'PreToolUse')).toBe('working')
    expect(reduceStatus('needs_input', 'PostToolUse')).toBe('working')
    expect(reduceStatus('working', 'PreToolUse')).toBe('working')
    expect(reduceStatus('idle', 'PostToolUse')).toBe('working')
  })

  it('is idle from the first output, and only from the first', () => {
    expect(reduceStatus('starting', 'output')).toBe('idle')
    for (const status of ALL.filter((s) => s !== 'starting')) expect(reduceStatus(status, 'output')).toBe(status)
  })

  it('has exited when the process has, whatever it was doing', () => {
    for (const status of ALL) expect(reduceStatus(status, 'exit')).toBe('exited')
  })

  it('stays exited', () => {
    for (const event of ['output', 'UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'SessionEnd']) {
      expect(reduceStatus('exited', event)).toBe('exited')
    }
  })

  it('is left unchanged by an event it does not know', () => {
    for (const status of ALL) {
      expect(reduceStatus(status, 'SubagentStop')).toBe(status)
      expect(reduceStatus(status, '')).toBe(status)
      expect(reduceStatus(status, 'toString')).toBe(status)
    }
  })
})

describe('sessionOfWorkspace', () => {
  it('is a session the manager has, in a folder directly under the open workspace', () => {
    expect(sessionOfWorkspace({ id: 'bracket', dir: '/ws/bracket' }, '/ws')).toBe(true)
  })

  it('is still one when its object has left the list: the last model file was deleted, and the agent is there to be told', () => {
    // Nothing is asked of the list of objects at all.
    expect(sessionOfWorkspace({ id: 'gear', dir: '/ws/gear' }, '/ws')).toBe(true)
  })

  it('is not one the manager does not have, one of a workspace that was left, or one deeper down', () => {
    expect(sessionOfWorkspace(undefined, '/ws')).toBe(false)
    expect(sessionOfWorkspace({ id: 'bracket', dir: '/old/bracket' }, '/ws')).toBe(false)
    expect(sessionOfWorkspace({ id: 'bracket', dir: '/ws/deep/bracket' }, '/ws')).toBe(false)
    expect(sessionOfWorkspace({ id: 'bracket', dir: '/ws/bracket' }, undefined)).toBe(false)
  })
})

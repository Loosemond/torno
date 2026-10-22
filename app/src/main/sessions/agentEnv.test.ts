import { describe, expect, it } from 'vitest'
import { agentEnv, withoutSession } from './agentEnv'

// What a session of an outer torno gave it, when torno was started from inside one.
const OUTER = { TORNO_SESSION: 'outer-token', TORNO_OBJECT: 'outer-object', TORNO_SESSION_ID: 'outer-session' }

describe('withoutSession', () => {
  it("takes out what an outer torno's session gave it, and keeps torno's switches and the rest", () => {
    expect(withoutSession({ ...OUTER, TORNO_KEEP_BUILDS: '1', TORNO_TEST: '1', PATH: '/bin', GONE: undefined })).toEqual({ TORNO_KEEP_BUILDS: '1', TORNO_TEST: '1', PATH: '/bin' })
  })
})

describe('agentEnv', () => {
  it("takes out an outer torno's session, torno's own switches and the marks of a Claude Code session", () => {
    expect(agentEnv({ ...OUTER, TORNO_KEEP_BUILDS: '1', CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'kept', PATH: '/bin' })).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'kept', PATH: '/bin' })
  })
})

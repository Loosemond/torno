/**
 * What a session gives its agent (`Sessions.begin`). torno started from inside one of its own sessions has an outer
 * torno's: its token would reach whatever torno starts, and a model that prints its environment would have it logged
 * where the inner torno's `redact` does not know it.
 */
const SESSION_VARIABLES = new Set(['TORNO_SESSION', 'TORNO_OBJECT', 'TORNO_SESSION_ID'])

/** torno's own switches (src/main/index.ts, e2e/): they mean nothing to the agent, or mislead what it starts. */
const OWN_VARIABLES = new Set(['TORNO_TEST', 'TORNO_AGENT_CMD', 'TORNO_CONFIG', 'TORNO_WORKSPACE', 'TORNO_DEBUG', 'TORNO_SHOTS', 'TORNO_BUILD_TIMEOUT', 'TORNO_KEEP_BUILDS', 'TORNO_EVAL', 'TORNO_EVAL_ABLATE', 'TORNO_EVAL_LOOK_SIZE', 'TORNO_EVAL_HOLDS', ...SESSION_VARIABLES])

/**
 * What a Claude Code session exports to the processes it starts. Only these:
 * other CLAUDE_CODE_* variables (CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_OAUTH_TOKEN, ...)
 * are settings a person makes on purpose, and the agent must get them.
 */
const PARENT_SESSION_VARIABLES = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_EFFORT',
  'CLAUDE_PID'
])

/**
 * The environment every process torno starts inherits (the kernel, the import of a scan, the readiness checks, and
 * through `agentEnv` the agent): torno's, without what a session of an outer torno gave it. torno's switches stay for
 * all but the agent: the kernel reads `TORNO_KEEP_BUILDS`.
 */
export function withoutSession(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !SESSION_VARIABLES.has(entry[0])))
}

/**
 * The environment an agent inherits: torno's, without torno's own switches and
 * without the marks of a Claude Code session. torno may have been started from
 * inside one, and the agent would then take itself for a child of that session.
 */
export function agentEnv(env: Record<string, string | undefined>): Record<string, string> {
  const kept = (name: string): boolean => !OWN_VARIABLES.has(name) && !PARENT_SESSION_VARIABLES.has(name)
  return Object.fromEntries(Object.entries(withoutSession(env)).filter(([name]) => kept(name)))
}

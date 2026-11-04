#!/usr/bin/env node
// The agent of an eval run, as torno starts it: `node tee.mjs <results file> <command> <args…>` (TORNO_AGENT_CMD).
// It runs the command with torno's arguments after its own, passes the pipes through untouched, and keeps a copy of
// each `result` message the CLI writes (its cost, tokens, turns and time) as a line of the results file, with only
// those fields: nothing of what was said, no address and no token (the token is in the environment, never in a
// message). Nothing else is written.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [results, command, ...args] = process.argv.slice(2)
if (!results || !command) {
  process.stderr.write('usage: tee.mjs <results file> <command> [args…]\n')
  process.exit(2)
}

const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] })
process.stdin.pipe(child.stdin)
child.stdin.on('error', () => {})
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal))

const KEPT = ['subtype', 'is_error', 'duration_ms', 'duration_api_ms', 'num_turns', 'total_cost_usd', 'usage', 'modelUsage']
createInterface({ input: child.stdout }).on('line', (line) => {
  process.stdout.write(`${line}\n`)
  if (!line.includes('"result"')) return
  try {
    const message = JSON.parse(line)
    if (message?.type !== 'result') return
    const kept = { at: Date.now() }
    for (const key of KEPT) if (message[key] !== undefined) kept[key] = message[key]
    appendFileSync(results, `${JSON.stringify(kept)}\n`)
  } catch {
    // Not JSON: torno says so; nothing is kept.
  }
})
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))

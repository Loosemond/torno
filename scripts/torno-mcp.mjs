#!/usr/bin/env node
// torno's tools for an agent torno did not start (a spike of #54): node scripts/torno-mcp.mjs [project folder]
//
// A stdio MCP server that the person adds to their own agent. It holds no secret and writes no file: it connects to
// the Unix socket the running torno opens when started with TORNO_OUTSIDE_AGENTS=1 ($XDG_RUNTIME_DIR/torno/door.sock,
// else $TMPDIR/torno-<uid>/door.sock), says which folder it is for, and passes lines both ways. torno asks the person
// in its window before any tool answers. Without torno it answers every request with an error the agent reads.
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const env = process.env
const dir = env.XDG_RUNTIME_DIR?.startsWith('/') ? join(env.XDG_RUNTIME_DIR, 'torno') : join(env.TMPDIR?.startsWith('/') ? env.TMPDIR : '/tmp', `torno-${process.getuid?.() ?? 'user'}`)
const folder = resolve(process.argv[2] ?? process.cwd())

/** What the agent that started this says it is: the name of the parent process, where the system says it. */
let client = 'unknown'
try {
  client = readFileSync(`/proc/${process.ppid}/comm`, 'utf8').trim()
} catch {
  // not Linux
}

const socket = connect(join(dir, 'door.sock'))
let connected = false
socket.on('connect', () => {
  connected = true
  socket.write(`${JSON.stringify({ torno: 'hello', folder, client, pid: process.ppid })}\n`)
  socket.pipe(process.stdout)
  process.stdin.pipe(socket)
})
socket.on('close', () => {
  if (connected) process.exit(0)
})
socket.on('error', () => {
  if (connected) return
  // No torno to talk to: say so to each request, until the agent closes the pipe.
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    try {
      const m = JSON.parse(line)
      if (m.id !== undefined && m.id !== null && typeof m.method === 'string')
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'torno is not running with TORNO_OUTSIDE_AGENTS=1: start it with `TORNO_OUTSIDE_AGENTS=1 scripts/torno <workspace>` and open this project' } })}\n`)
    } catch {
      // not JSON
    }
  })
  lines.on('close', () => process.exit(0))
})

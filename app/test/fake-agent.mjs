// Stands in for the agent's CLI in tests. Takes the arguments torno gives
// Claude Code and behaves just enough like it:
//   - prints `READY <argv as JSON>` at start;
//   - echoes each line of input back, prefixed with `> ` (an escape character as `\e`);
//   - on the line `hook`, posts a UserPromptSubmit body to the hook URL found
//     in its --settings argument and prints the additionalContext it is given;
//     `hook <Event> [session id]` posts another event, or as another conversation;
//   - on the line `size`, prints the size of its terminal;
//   - on the line `env`, prints the names of its HOME, PATH, TORNO*, CLAUDE*,
//     ANTHROPIC* and COPILOT* variables, sorted, as JSON;
//   - on the line `file <path>`, prints `file: ` and the first 200 characters
//     of that file on one line, or `file: none`;
//   - on the line `args`, prints its READY line again;
//   - on the line `palette`, prints the sixteen ANSI colours;
//   - on the line `child`, starts a process of its own that ignores SIGHUP, as
//     a tool the agent runs might, and prints `child: <pid>`;
//   - on the line `exit`, exits.
// Started with another agent's arguments (Copilot CLI's: no --settings) it has
// no hook to post, and `hook` prints `no UserPromptSubmit hook`.
// With FAKE_AGENT_STUBBORN=1 it ignores SIGHUP, like a process that has hung.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
const after = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
const settings = JSON.parse(after('--settings') ?? '{}')
const conversation = after('--session-id') ?? after('--resume') ?? ''

if (process.env.FAKE_AGENT_STUBBORN === '1') process.on('SIGHUP', () => {})

async function hook(event, sessionId) {
  const url = settings.hooks?.[event]?.[0]?.hooks?.[0]?.url
  if (!url) return console.log(`no ${event} hook`)
  const body = { session_id: sessionId, cwd: process.cwd(), hook_event_name: event }
  if (event === 'UserPromptSubmit') body.prompt = 'hello'
  const reply = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const answer = await reply.json().catch(() => ({}))
  if (!reply.ok) console.log(`${event}: HTTP ${reply.status}`)
  else if (event === 'UserPromptSubmit') console.log(`context: ${answer.hookSpecificOutput?.additionalContext ?? '(none)'}`)
  else console.log(`${event}: ok`)
}

function palette() {
  for (const base of [30, 90]) {
    let line = ''
    for (let i = 0; i < 8; i += 1) line += `\x1b[${base + i}m colour${base === 30 ? i : i + 8} \x1b[0m`
    console.log(line)
  }
}

function fileStart(path) {
  try {
    return readFileSync(path, 'utf8').slice(0, 200).replace(/\s+/g, ' ')
  } catch {
    return 'none'
  }
}

console.log(`READY ${JSON.stringify(argv)}`)

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  console.log(`> ${line.replaceAll('\x1b', '\\e')}`)
  const [word, event, sessionId] = line.trim().split(/\s+/)
  if (word === 'hook') void hook(event ?? 'UserPromptSubmit', sessionId ?? conversation).catch((e) => console.log(`hook failed: ${e.message}`))
  else if (word === 'size') console.log(`size: ${process.stdout.columns}x${process.stdout.rows}`)
  else if (word === 'env') console.log(`env: ${JSON.stringify(Object.keys(process.env).filter((name) => /^(HOME$|PATH$|TORNO|CLAUDE|ANTHROPIC|COPILOT)/.test(name)).sort())}`)
  else if (word === 'file') console.log(`file: ${fileStart(line.trim().slice('file'.length).trim())}`)
  else if (word === 'args') console.log(`READY ${JSON.stringify(argv)}`)
  else if (word === 'palette') palette()
  else if (word === 'child') {
    const child = spawn(process.execPath, ['-e', "process.on('SIGHUP', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' })
    console.log(`child: ${child.pid}`)
  } else if (word === 'exit') process.exit(0)
})
lines.on('close', () => process.exit(0))

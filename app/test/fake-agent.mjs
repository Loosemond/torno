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
//   - on the line `dialog`, shows nothing of what is typed until the next line,
//     as a CLI does while a question of its own is up in place of its prompt,
//     and answers that line with `dialog: answered` and nothing else;
//   - on the line `palette`, prints the sixteen ANSI colours;
//   - on the line `ground <r> <g> <b>`, goes to the other screen and paints the whole of it in that colour, as a
//     CLI with a ground of its own does (Copilot CLI's); `ground` alone goes back to the main screen;
//   - on the line `child`, starts a process of its own that ignores SIGHUP, as
//     a tool the agent runs might, and prints `child: <pid>`;
//   - on the line `exit`, exits.
// Started with another agent's arguments (Copilot CLI's: no --settings) it has
// no hook to post, and `hook` prints `no UserPromptSubmit hook`.
// With FAKE_AGENT_STUBBORN=1 it ignores SIGHUP, like a process that has hung (in stream mode also SIGTERM and the
// end of its stdin).
//
// Stream mode: started with `--input-format stream-json` (Claude Code's headless mode, `claude.ts` in view `chat`)
// it speaks that protocol on stdout and stdin, one JSON object per line, and prints nothing else. It follows
// app/test/fixtures/claude-stream.jsonl:
//   - `control_request` `initialize` is answered with two commands and two models, `set_model` with `{}` (the
//     model is then the `model` of the next `init`), `interrupt` with `{ still_queued: [] }` (the prompts waiting are
//     dropped), and ends the turn in
//     progress: a `user` message `[Request interrupted by user]` and a `result` of `error_during_execution`;
//   - each `user` message is a prompt, run in turn (prompts that come while one runs wait): it posts
//     `UserPromptSubmit` (`session_id`, `prompt`) to the hook URL of its --settings, if there is one, emits
//     `system`/`init` (with `fake_argv`, its arguments) and, for what the hook answered, a `system`/`hook_response`,
//     runs the script that is the prompt's text, posts `Stop` and emits `result`;
//   - a prompt `/noop` is no turn: an `init` and nothing else;
//   - the script is one command per line (a line that is none is `say <line>`):
//       say <text>                a streamed text, then the whole assistant message
//       tool <name> <json input>  a tool_use, PreToolUse/PostToolUse, a tool_result `ran <name>`; for a name that
//                                 begins `mcp__torno__` torno's MCP server is called for real and the tool_result
//                                 holds its `content` as it came
//       ask <name> <json input>   a `can_use_tool` control_request, waits for its answer, a tool_result
//                                 `allowed: <json updatedInput>` or `denied: <message>`
//       slow <seconds>            a word every 100 ms for that long
//       rate <percent>            a `rate_limit_event` at that utilization
//       garbage                   a line that is no JSON, and an object of a type nobody knows
//   - when stdin ends it posts `SessionEnd` and exits 0; on SIGTERM it exits 0.
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

if (after('--input-format') === 'stream-json') {
  await streamMode()
} else {
  terminalMode()
}

async function streamMode() {
  const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
  const stubborn = process.env.FAKE_AGENT_STUBBORN === '1'
  process.on('SIGTERM', () => {
    if (!stubborn) process.exit(0)
  })
  let model = 'fake-model'
  let counter = 0
  const next = (prefix) => `${prefix}_${(counter += 1)}`
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  /** The turn in progress: aborted by an interrupt, which wakes whatever it waits for. */
  let turn = null
  const queue = []
  const answers = new Map()

  const base = { session_id: conversation, parent_tool_use_id: null }
  const message = (content, id = next('msg')) => ({ type: 'assistant', message: { id, type: 'message', role: 'assistant', model, content }, ...base, uuid: next('uuid') })

  const post = async (event, extra = {}) => {
    const url = settings.hooks?.[event]?.[0]?.hooks?.[0]?.url
    if (!url) return undefined
    const body = { session_id: conversation, cwd: process.cwd(), hook_event_name: event, ...extra }
    const reply = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined)
    return reply?.ok ? await reply.json().catch(() => undefined) : undefined
  }

  /** Wait, or until the turn is interrupted. */
  const pause = (ms) => Promise.race([sleep(ms), turn.interrupted])

  async function say(text) {
    const id = next('msg')
    const event = (e) => out({ type: 'stream_event', event: e, ...base, uuid: next('uuid') })
    event({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [] } })
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    for (const word of text.split(/(?<= )/)) {
      if (turn.aborted) return
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } })
      await pause(20)
    }
    event({ type: 'content_block_stop', index: 0 })
    event({ type: 'message_stop' })
    out(message([{ type: 'text', text }], id))
  }

  async function mcp(name, input) {
    const url = JSON.parse(after('--mcp-config') ?? '{}').mcpServers?.torno?.url
    if (!url) return { content: [{ type: 'text', text: 'no torno MCP server' }], isError: true }
    const rpc = async (method, params, id) => {
      const reply = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id ? { id } : {}) }) })
      const text = await reply.text()
      const data = text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).at(-1) : text
      return data ? JSON.parse(data) : undefined
    }
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake-agent', version: '1' } }, 1)
    const answer = await rpc('tools/call', { name: name.slice('mcp__torno__'.length), arguments: input }, 2)
    return answer?.result ?? { content: [{ type: 'text', text: JSON.stringify(answer?.error ?? answer) }], isError: true }
  }

  async function tool(name, input, asked) {
    const id = next('toolu')
    out(message([{ type: 'tool_use', id, name, input }]))
    let content = `ran ${name}`
    let isError = false
    if (asked) {
      const requestId = next('req_perm')
      const wait = new Promise((resolve) => answers.set(requestId, resolve))
      out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: name, input, tool_use_id: id, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: name }], behavior: 'allow', destination: 'session' }] } })
      const response = await Promise.race([wait, turn.interrupted])
      if (turn.aborted) return
      if (response?.behavior === 'allow') content = `allowed: ${JSON.stringify(response.updatedInput)}`
      else content = `denied: ${response?.message ?? ''}`
    }
    await post('PreToolUse', { tool_name: name })
    if (!asked && name.startsWith('mcp__torno__')) {
      const result = await mcp(name, input).catch((e) => ({ content: [{ type: 'text', text: e.message }], isError: true }))
      content = result.content
      isError = result.isError === true
    }
    await post('PostToolUse', { tool_name: name })
    out({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error: isError }] }, ...base, uuid: next('uuid') })
  }

  async function run(command, rest) {
    if (command === 'tool' || command === 'ask') {
      const space = rest.indexOf(' ')
      const name = space < 0 ? rest : rest.slice(0, space)
      await tool(name, space < 0 ? {} : JSON.parse(rest.slice(space + 1)), command === 'ask')
    } else if (command === 'slow') {
      const until = Date.now() + Number(rest) * 1000
      let i = 0
      while (Date.now() < until && !turn.aborted) {
        out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `word${(i += 1)} ` } }, ...base, uuid: next('uuid') })
        await pause(100)
      }
    } else if (command === 'rate') {
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: Number(rest) / 100, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } }, ...base, uuid: next('uuid') })
    } else if (command === 'garbage') {
      process.stdout.write('this is not json, a warning the CLI printed\n')
      out({ type: 'from_the_future', something: [1, 2, 3], ...base })
    } else {
      await say(command === 'say' ? rest : `${command} ${rest}`.trim())
    }
  }

  async function prompt(content) {
    const text = content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    const started = Date.now()
    // A prompt that is no turn (a slash command that only does something): an init, no hooks, no result.
    if (text.trim() === '/noop') {
      out({ type: 'system', subtype: 'init', cwd: process.cwd(), model, tools: [], mcp_servers: [], fake_argv: argv, ...base, uuid: next('uuid') })
      return
    }
    let release
    turn = { aborted: false, interrupted: new Promise((resolve) => (release = resolve)) }
    turn.interrupt = () => {
      turn.aborted = true
      release()
    }
    const submitted = await post('UserPromptSubmit', { prompt: text })
    out({ type: 'system', subtype: 'init', cwd: process.cwd(), model, tools: [], mcp_servers: [{ name: 'torno', status: 'connected' }], fake_argv: argv, ...base, uuid: next('uuid') })
    const context = submitted?.hookSpecificOutput?.additionalContext
    if (context) out({ type: 'system', subtype: 'hook_response', hook_event: 'UserPromptSubmit', output: context, ...base, uuid: next('uuid') })
    for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (turn.aborted) break
      const space = line.indexOf(' ')
      await run(space < 0 ? line : line.slice(0, space), space < 0 ? '' : line.slice(space + 1))
    }
    const stopped = turn.aborted
    if (stopped) out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, ...base, uuid: next('uuid') })
    else await post('Stop')
    out({ type: 'result', subtype: stopped ? 'error_during_execution' : 'success', is_error: stopped, duration_ms: Date.now() - started, duration_api_ms: 1, num_turns: 1, stop_reason: stopped ? 'tool_use' : 'end_turn', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, ...base, uuid: next('uuid') })
    turn = null
  }

  let draining = false
  async function drain() {
    if (draining) return
    draining = true
    while (queue.length > 0) await prompt(queue.shift())
    draining = false
  }

  function control(request_id, request) {
    const reply = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id, response } })
    if (request?.subtype === 'initialize') {
      reply({
        commands: [{ name: 'compact', description: 'Compact the conversation', argumentHint: '' }, { name: 'clear', description: 'Clear', argumentHint: '' }],
        models: [{ value: 'default', displayName: 'Default' }, { value: 'haiku', displayName: 'Haiku' }]
      })
    } else if (request?.subtype === 'set_model') {
      model = request.model
      reply({})
    } else if (request?.subtype === 'interrupt') {
      // What was queued behind the turn is dropped, as the CLI does.
      queue.length = 0
      reply({ still_queued: [] })
      turn?.interrupt()
    } else {
      out({ type: 'control_response', response: { subtype: 'error', request_id, error: `unknown request ${request?.subtype}` } })
    }
  }

  const input = createInterface({ input: process.stdin })
  input.on('line', (line) => {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m.type === 'control_request') control(m.request_id, m.request)
    else if (m.type === 'control_response') answers.get(m.response?.request_id)?.(m.response?.response)
    else if (m.type === 'user') {
      queue.push(Array.isArray(m.message?.content) ? m.message.content : [{ type: 'text', text: String(m.message?.content ?? '') }])
      void drain()
    }
  })
  input.on('close', async () => {
    await post('SessionEnd')
    if (stubborn) setInterval(() => {}, 1000)
    else process.exit(0)
  })
  await new Promise(() => {})
}

function terminalMode() {
console.log(`READY ${JSON.stringify(argv)}`)

const lines = createInterface({ input: process.stdin })
let asking = false
lines.on('line', (line) => {
  if (asking) {
    asking = false
    process.stdin.setRawMode?.(false)
    return console.log('dialog: answered')
  }
  console.log(`> ${line.replaceAll('\x1b', '\\e')}`)
  const [word, event, sessionId] = line.trim().split(/\s+/)
  if (word === 'hook') void hook(event ?? 'UserPromptSubmit', sessionId ?? conversation).catch((e) => console.log(`hook failed: ${e.message}`))
  else if (word === 'size') console.log(`size: ${process.stdout.columns}x${process.stdout.rows}`)
  else if (word === 'env') console.log(`env: ${JSON.stringify(Object.keys(process.env).filter((name) => /^(HOME$|PATH$|TORNO|CLAUDE|ANTHROPIC|COPILOT)/.test(name)).sort())}`)
  else if (word === 'file') console.log(`file: ${fileStart(line.trim().slice('file'.length).trim())}`)
  else if (word === 'dialog') {
    asking = true
    process.stdin.setRawMode?.(true)
    console.log('dialog: up')
  } else if (word === 'args') console.log(`READY ${JSON.stringify(argv)}`)
  else if (word === 'palette') palette()
  else if (word === 'ground') {
    const [r, g, b] = line.trim().split(/\s+/).slice(1).map(Number)
    // On the other screen, as a full-screen CLI draws, erased in the colour that is set: the whole of it takes the
    // colour. Without one, back to the main screen, as it was.
    if (r === undefined) process.stdout.write('\x1b[0m\x1b[?1049l')
    else {
      process.stdout.write(`\x1b[?1049h\x1b[48;2;${r};${g};${b}m\x1b[2J\x1b[H`)
      console.log('ground: painted')
    }
  }
  else if (word === 'child') {
    const child = spawn(process.execPath, ['-e', "process.on('SIGHUP', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' })
    console.log(`child: ${child.pid}`)
  } else if (word === 'exit') process.exit(0)
})
lines.on('close', () => process.exit(0))
}

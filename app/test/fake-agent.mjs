// Stands in for the agent's CLI in tests. Takes the arguments torno gives
// Claude Code and behaves just enough like it:
//   - prints `READY <argv as JSON>` at start;
//   - echoes each line of input back, prefixed with `> ` (an escape character as `\e`);
//   - on the line `hook`, posts a UserPromptSubmit body to the hook URL found
//     in its --settings argument and prints the additionalContext it is given;
//     `hook <Event> [session id]` posts another event, or as another conversation;
//   - on the line `size`, prints the size of its terminal;
//   - on the line `env`, prints the names of its HOME, PATH, TORNO*, CLAUDE* and
//     ANTHROPIC* variables, sorted, as JSON;
//   - on the line `args`, prints its READY line again;
//   - on the line `palette`, prints the sixteen ANSI colours;
//   - on the line `ground <r> <g> <b>`, goes to the other screen and paints the whole of it in that colour, as a
//     CLI with a ground of its own does; `ground` alone goes back to the main screen;
//   - on the line `child`, starts a process of its own that ignores SIGHUP, as
//     a tool the agent runs might, and prints `child: <pid>`;
//   - on the line `exit`, exits.
// With FAKE_AGENT_STUBBORN=1 it ignores SIGHUP, like a process that has hung (in stream mode also SIGTERM and the
// end of its stdin).
//
// Stream mode: started with `--input-format stream-json` (Claude Code's headless mode, `claude.ts` in view `chat`)
// it speaks that protocol on stdout and stdin, one JSON object per line, and prints nothing else. It follows
// app/test/fixtures/claude-stream.jsonl:
//   - `control_request` `initialize` is answered with two commands and two models, `set_model` with `{}` (the
//     model is then the `model` of the next `init`), `interrupt` with `{ still_queued: [<uuids of the prompts waiting>] }`
//     (they are KEPT, as the real CLI does, seen 2026-10-15) and ends the turn in progress: a `user` message
//     `[Request interrupted by user]` and a `result` of `error_during_execution`; the prompts kept then run together,
//     in one turn with one `init` and a hook for each;
//   - a `user` line may carry a `uuid`; for each prompt that has one it emits `command_lifecycle` (`command_uuid`,
//     `state`): `queued` when the prompt comes while a turn is at work, `started` when it begins, `completed` after
//     its turn's `result`;
//   - each `user` message is a prompt, run in turn (prompts that come while one runs wait): it posts
//     `UserPromptSubmit` (`session_id`, `prompt`) to the hook URL of its --settings, if there is one, emits
//     `system`/`init` (with `fake_argv`, its arguments) and, for what the hook answered, a `system`/`hook_response`,
//     runs the script that is the prompt's text, posts `Stop` and emits `result`;
//   - a prompt `/noop` is no turn: an `init` and nothing else;
//   - a prompt `/silent` is taken up with no `init`, no hook and no result: only a `rate_limit_event`;
//   - a prompt `/compact` is what the CLI does for it (claude-stream-asks.jsonl): an `init`, a `compact_boundary`
//     (29,569 -> 3,637 tokens), the replay of its output and a `result` of no turns; no hooks;
//   - a request's `permission_suggestions` are the three kinds the CLI sends (a rule for the settings of the folder,
//     a directory, a mode); its `description` and `blocked_path` are those of the input when it has them;
//   - the script is one command per line (a line that is none is `say <line>`):
//       say <text>                a streamed text, then the whole assistant message
//       tool <name> <json input>  a tool_use, PreToolUse/PostToolUse, a tool_result `ran <name>`; for a name that
//                                 begins `mcp__torno__` torno's MCP server is called for real and the tool_result
//                                 holds its `content` as it came
//       ask <name> <json input>   a `can_use_tool` control_request, waits for its answer, a tool_result
//                                 `allowed: <json updatedInput>` (and, when the answer carried them, a second line
//                                 `permissions: <json updatedPermissions>`) or `denied: <message>`
//       slow <seconds>            a word every 100 ms for that long
//       rate <percent>            a `rate_limit_event` at that utilization
//       images                    says what pictures came with the prompt: `images: <n> <width>x<height> ...`, the
//                                 size read from each PNG's header (a text, as `say` is)
//       garbage                   a line that is no JSON, and an object of a type nobody knows
//       work <seconds>            a tool (Bash) that takes that long
//       argv                      says its own arguments as JSON (a text, as `say` is)
//       retry <attempt> [<s>]     a `system`/`api_retry` at that attempt, as the CLI says while the API is retried, then
//                                 nothing for that many seconds (the next thing it says is the API's answer)
//       deny <name> <json input>  a permission the CLI denied by itself (no ask): it is in the `permission_denials` of the
//                                 turn's `result`, with no tool card
//   - a prompt that comes while a tool runs or an ask waits is FOLDED into the turn at work, as the real CLI does
//     (seen 2026-10-15): after the tool's result the stand-in posts that prompt's `UserPromptSubmit` and runs its script
//     in the same turn, with no `init` of its own and ONE `result` for both. A prompt that comes while text is being
//     said (`slow`) or while the CLI is between commands waits for the turn to end and is a turn of its own;
//   - an `interrupt` while an ask waits sends `control_cancel_request` for it first, then answers the interrupt, as the CLI does;
//   - when stdin ends it posts `SessionEnd` and exits 0; on SIGTERM it exits 0.
// Every `init` has the CLI's account of itself as the recordings have it: `plugins` (torno's, when started with
// `--plugin-dir`), `skills` (the person's own, none of a plugin's), `apiKeySource` `none` and `claude_code_version`
// 2.1.300. With FAKE_AGENT_INIT=<json object> in stream mode its fields replace these, so a case is played:
// `{"plugins":[]}` (torno's plugin did not load), `{"apiKeySource":"user"}`, `{"claude_code_version":"2.2.0"}`,
// `{"mcp_servers":[{"name":"torno","status":"failed"}],"mcp_server_errors":[...]}`, `{"plugin_errors":[...]}`.
// With FAKE_AGENT_FAIL=<text> in stream mode it writes <text> to stderr and exits 1 at once, before a line of output
// (a CLI that is too old for a flag, or signed out). With FAKE_AGENT_INIT_ERROR=<text> it answers `initialize` with that error.
import { spawn } from 'node:child_process'
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

if (after('--input-format') === 'stream-json') {
  await streamMode()
} else {
  terminalMode()
}

async function streamMode() {
  if (process.env.FAKE_AGENT_FAIL) {
    process.stderr.write(`${process.env.FAKE_AGENT_FAIL}\n`)
    process.exit(1)
  }
  const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
  const stubborn = process.env.FAKE_AGENT_STUBBORN === '1'
  process.on('SIGTERM', () => {
    if (!stubborn) process.exit(0)
  })
  let model = 'fake-model'
  /** FAKE_AGENT_INIT: fields of the CLI's own account of itself, put in every `init`. */
  const account = {
    // As the recordings are (2.1.300): the plugins loaded are listed (torno's when it was given a folder), `skills` holds only the person's own.
    plugins: argv.includes('--plugin-dir') ? [{ name: 'torno', path: after('--plugin-dir'), source: 'torno@inline' }] : [],
    skills: ['humanizer', 'log-note', 'vault-report'],
    apiKeySource: 'none',
    claude_code_version: '2.1.300',
    ...JSON.parse(process.env.FAKE_AGENT_INIT || '{}')
  }
  let counter = 0
  const next = (prefix) => `${prefix}_${(counter += 1)}`
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  /** The turn in progress: aborted by an interrupt, which wakes whatever it waits for. */
  let turn = null
  /** Prompts waiting for the turn at work: `{ content, uuid }`. */
  const queue = []
  /** After an interrupt the prompts that were queued run together, in one turn with one `init`, as the CLI does. */
  let together = false
  const life = (uuid, state) => {
    if (uuid) out({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: next('uuid'), session_id: conversation })
  }
  const answers = new Map()
  /** The requests an ask waits on, which an interrupt cancels. */
  const pending = new Set()

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

  async function tool(name, input, asked, holdMs = 0) {
    // A prompt that comes now is folded into the turn.
    turn.foldable = true
    const id = next('toolu')
    out(message([{ type: 'tool_use', id, name, input }]))
    let content = `ran ${name}`
    let isError = false
    if (asked) {
      const requestId = next('req_perm')
      const wait = new Promise((resolve) => answers.set(requestId, resolve))
      pending.add(requestId)
      out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: name, input, tool_use_id: id, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: name }], behavior: 'allow', destination: 'localSettings' }, { type: 'addDirectories', directories: [process.cwd()], destination: 'session' }, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }], display_name: name, ...(typeof input?.description === 'string' ? { description: input.description } : {}), ...(typeof input?.blocked_path === 'string' ? { blocked_path: input.blocked_path } : {}) } })
      const response = await Promise.race([wait, turn.interrupted])
      pending.delete(requestId)
      if (turn.aborted) return
      if (response?.behavior === 'allow') content = `allowed: ${JSON.stringify(response.updatedInput)}${response.updatedPermissions ? `\npermissions: ${JSON.stringify(response.updatedPermissions)}` : ''}`
      else content = `denied: ${response?.message ?? ''}`
    }
    await post('PreToolUse', { tool_name: name })
    if (holdMs > 0) await pause(holdMs)
    if (turn.aborted) {
      // As the CLI does for a tool that was running: its result is the rejection, and the interrupt note says "for tool use".
      if (holdMs > 0) {
        out({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.", is_error: true }] }, ...base, uuid: next('uuid') })
        turn.forTool = true
      }
      return
    }
    if (!asked && name.startsWith('mcp__torno__')) {
      const result = await mcp(name, input).catch((e) => ({ content: [{ type: 'text', text: e.message }], isError: true }))
      content = result.content
      isError = result.isError === true
    }
    await post('PostToolUse', { tool_name: name })
    out({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error: isError }] }, ...base, uuid: next('uuid') })
    turn.foldable = false
    await takeFolded()
  }

  /** The prompts that came while a tool ran, taken up now: their hook, then their script, in this turn. */
  async function takeFolded() {
    while (turn.folded.length > 0 && !turn.aborted) {
      const { content, uuid } = turn.folded.shift()
      life(uuid, 'started')
      turn.taken.push(uuid)
      const text = content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
      turn.images.push(...content.filter((b) => b?.type === 'image' && typeof b.source?.data === 'string').map((b) => b.source.data))
      const submitted = await post('UserPromptSubmit', { prompt: text })
      const context = submitted?.hookSpecificOutput?.additionalContext
      if (context) out({ type: 'system', subtype: 'hook_response', hook_event: 'UserPromptSubmit', output: context, ...base, uuid: next('uuid') })
      await script(text)
    }
  }

  async function script(text) {
    for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (turn.aborted) break
      const space = line.indexOf(' ')
      await run(space < 0 ? line : line.slice(0, space), space < 0 ? '' : line.slice(space + 1))
    }
  }

  async function run(command, rest) {
    if (command === 'tool' || command === 'ask') {
      const space = rest.indexOf(' ')
      const name = space < 0 ? rest : rest.slice(0, space)
      await tool(name, space < 0 ? {} : JSON.parse(rest.slice(space + 1)), command === 'ask')
    } else if (command === 'work') {
      await tool('Bash', { command: `sleep ${rest}` }, false, Number(rest) * 1000)
    } else if (command === 'slow') {
      const until = Date.now() + Number(rest) * 1000
      const event = (e) => out({ type: 'stream_event', event: e, ...base, uuid: next('uuid') })
      let i = 0
      let words = ''
      event({ type: 'message_start', message: { id: 'msg_slow', type: 'message', role: 'assistant', model, content: [] } })
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      while (Date.now() < until && !turn.aborted) {
        const word = `word${(i += 1)} `
        words += word
        event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } })
        await pause(100)
      }
      // An interrupt leaves the block open, as the CLI does: nothing says it ended.
      if (!turn.aborted) {
        event({ type: 'content_block_stop', index: 0 })
        event({ type: 'message_stop' })
        out(message([{ type: 'text', text: words }], 'msg_slow'))
      }
    } else if (command === 'images') {
      const sizes = turn.images.map((data) => {
        const png = Buffer.from(data, 'base64')
        return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`
      })
      await say(`images: ${sizes.length} ${sizes.join(' ')}`.trim())
    } else if (command === 'rate') {
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: Number(rest) / 100, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } }, ...base, uuid: next('uuid') })
    } else if (command === 'argv') {
      await say(JSON.stringify(argv))
    } else if (command === 'retry') {
      const [attempt, wait] = rest.split(' ')
      out({ type: 'system', subtype: 'api_retry', attempt: Number(attempt), max_retries: 10, retry_delay_ms: 500, error_status: 529, error: 'overloaded', ...base, uuid: next('uuid') })
      if (wait) await pause(Number(wait) * 1000)
    } else if (command === 'deny') {
      const space = rest.indexOf(' ')
      turn.denials.push({ tool_name: space < 0 ? rest : rest.slice(0, space), tool_use_id: next('toolu'), tool_input: space < 0 ? {} : JSON.parse(rest.slice(space + 1)) })
    } else if (command === 'garbage') {
      process.stdout.write('this is not json, a warning the CLI printed\n')
      out({ type: 'from_the_future', something: [1, 2, 3], ...base })
    } else {
      await say(command === 'say' ? rest : `${command} ${rest}`.trim())
    }
  }

  async function prompt(entries) {
    const content = entries.flatMap((e) => e.content)
    const text = entries.map((e) => e.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')).join('\n')
    const started = Date.now()
    const done = () => entries.forEach((e) => life(e.uuid, 'completed'))
    // A prompt that is no turn (a slash command that only does something): an init, no hooks, no result.
    if (text.trim() === '/noop') {
      out({ type: 'system', subtype: 'init', cwd: process.cwd(), model, tools: [], mcp_servers: [], fake_argv: argv, ...account, ...base, uuid: next('uuid') })
      return done()
    }
    // A command the CLI takes up with no `init`, no hook and no result: it only says something else (a rate limit).
    if (text.trim() === '/silent') {
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1 } } }, ...base, uuid: next('uuid') })
      return done()
    }
    if (text.trim() === '/compact') {
      out({ type: 'system', subtype: 'init', cwd: process.cwd(), model, tools: [], mcp_servers: [{ name: 'torno', status: 'connected' }], fake_argv: argv, ...account, ...base, uuid: next('uuid') })
      out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 29569, post_tokens: 3637 }, ...base, uuid: next('uuid') })
      out({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }, isReplay: true, ...base, uuid: next('uuid') })
      out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 0, num_turns: 0, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 }, ...base, uuid: next('uuid') })
      return done()
    }
    let release
    const images = content.filter((b) => b?.type === 'image' && typeof b.source?.data === 'string').map((b) => b.source.data)
    turn = { aborted: false, foldable: false, denials: [], folded: [], taken: entries.map((e) => e.uuid), images, interrupted: new Promise((resolve) => (release = resolve)) }
    turn.interrupt = () => {
      turn.aborted = true
      release()
    }
    // Each prompt has its hook; the turn has one `init`.
    const contexts = []
    for (const entry of entries) {
      const submitted = await post('UserPromptSubmit', { prompt: entry.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') })
      contexts.push(submitted?.hookSpecificOutput?.additionalContext)
    }
    out({ type: 'system', subtype: 'init', cwd: process.cwd(), model, tools: [], mcp_servers: [{ name: 'torno', status: 'connected' }], fake_argv: argv, ...account, ...base, uuid: next('uuid') })
    for (const context of contexts) if (context) out({ type: 'system', subtype: 'hook_response', hook_event: 'UserPromptSubmit', output: context, ...base, uuid: next('uuid') })
    await script(text)
    await takeFolded()
    const stopped = turn.aborted
    if (stopped) out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: turn.forTool ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]' }] }, ...base, uuid: next('uuid') })
    else await post('Stop')
    out({ type: 'result', subtype: stopped ? 'error_during_execution' : 'success', is_error: stopped, duration_ms: Date.now() - started, duration_api_ms: 1, num_turns: 1, stop_reason: stopped ? 'tool_use' : 'end_turn', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: turn.denials, ...base, uuid: next('uuid') })
    for (const uuid of turn.taken) life(uuid, 'completed')
    turn = null
  }

  let draining = false
  async function drain() {
    if (draining) return
    draining = true
    while (queue.length > 0) {
      const entries = together ? queue.splice(0) : [queue.shift()]
      together = false
      for (const entry of entries) life(entry.uuid, 'started')
      await prompt(entries)
    }
    draining = false
  }

  function control(request_id, request) {
    const reply = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id, response } })
    if (request?.subtype === 'initialize' && process.env.FAKE_AGENT_INIT_ERROR) {
      out({ type: 'control_response', response: { subtype: 'error', request_id, error: process.env.FAKE_AGENT_INIT_ERROR } })
    } else if (request?.subtype === 'initialize') {
      reply({
        commands: [{ name: 'compact', description: 'Compact the conversation', argumentHint: '' }, { name: 'clear', description: 'Clear', argumentHint: '' }],
        models: [{ value: 'default', displayName: 'Default' }, { value: 'haiku', displayName: 'Haiku' }]
      })
    } else if (request?.subtype === 'set_model') {
      model = request.model
      reply({})
    } else if (request?.subtype === 'interrupt') {
      // What was queued behind the turn is not dropped, as the CLI does: it runs after the interrupted turn, together.
      if (turn) queue.push(...turn.folded.splice(0))
      together = queue.length > 0
      // What the CLI had asked is given up first.
      for (const id of pending) out({ type: 'control_cancel_request', request_id: id })
      pending.clear()
      reply({ still_queued: queue.map((e) => e.uuid).filter(Boolean) })
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
      const content = Array.isArray(m.message?.content) ? m.message.content : [{ type: 'text', text: String(m.message?.content ?? '') }]
      const uuid = typeof m.uuid === 'string' ? m.uuid : undefined
      // One that comes while a turn is at work is queued, and the CLI says so.
      if (draining || turn) life(uuid, 'queued')
      // Not a command of the CLI's own, which is never folded.
      if (turn?.foldable && !content.some((b) => b?.type === 'text' && b.text.trim().startsWith('/'))) return void turn.folded.push({ content, uuid })
      queue.push({ content, uuid })
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
lines.on('line', (line) => {
  console.log(`> ${line.replaceAll('\x1b', '\\e')}`)
  const [word, event, sessionId] = line.trim().split(/\s+/)
  if (word === 'hook') void hook(event ?? 'UserPromptSubmit', sessionId ?? conversation).catch((e) => console.log(`hook failed: ${e.message}`))
  else if (word === 'size') console.log(`size: ${process.stdout.columns}x${process.stdout.rows}`)
  else if (word === 'env') console.log(`env: ${JSON.stringify(Object.keys(process.env).filter((name) => /^(HOME$|PATH$|TORNO|CLAUDE|ANTHROPIC)/.test(name)).sort())}`)
  else if (word === 'args') console.log(`READY ${JSON.stringify(argv)}`)
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

# Chat: Claude Code in torno's own pane — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code runs in a chat pane of torno's own (not a terminal), where the person sees, beside the conversation, what torno gave the agent with each prompt (marks, dimensions, selection, build) and every torno tool the agent called (pictures, measurements, marks), with refs that point into the viewport.

**Architecture:** The real `claude` CLI is started in its headless streaming mode (`-p --input-format stream-json --output-format stream-json`) through pipes instead of a PTY. Main frames its JSON lines, answers its control requests (permission prompts, questions), reduces the stream to a transcript of items (`shared/chat.ts`), keeps it per session, writes the finished items to `<object>/.torno/chat/<conversation>.jsonl`, and sends items to the window, which draws them (`ui/chat/`). Hooks, the MCP server and the context that goes with every prompt stay exactly as they are; the context each `UserPromptSubmit` answered with is also put in the transcript, under the prompt it went with. The terminal stays: Claude Code can be switched between "Chat" and "Terminal" (same conversation, resumed), and Copilot CLI stays a terminal.

**Tech Stack:** as torno: Electron 44, electron-vite, React 19, Zustand, TypeScript, vitest, Playwright. No new dependency (the markdown of the agent's text is drawn by a small renderer of torno's own).

**Spec:** `docs/superpowers/specs/2026-10-08-torno-design.md` (sections on sessions, context and marks), and the Design section below, which this plan adds to it.

## Global Constraints

Everything in the root `CLAUDE.md` and in the folder `CLAUDE.md` of every folder touched holds. In particular:

- **The owner works on this desktop.** Every Electron launch in tests sets `TORNO_TEST=1` (hidden window). Never `--ozone-platform=headless`, never `page.screenshot()` of a hidden window, never the clipboard.
- **No real agent CLI in tests.** Tests run `TORNO_AGENT_CMD="node app/test/fake-agent.mjs"`. Never `claude` or `copilot`.
- Never touch `/home/luisgonc/objects` or `/home/luisgonc/Downloads`; tests use temp copies of `app/e2e/fixtures` or `kernel/tests/fixtures`. Never write under the real home config in tests.
- Never write inside a user workspace except under `<object>/.torno/`.
- `uv run --no-sync` only, never `uv sync`. No new npm dependency (`pnpm add` is not allowed: `node_modules` is shared with the owner's checkout).
- The run's secret never reaches a log or a file (`HttpRouter.redact`); `.torno/chat/` never holds an address.
- Every key is a row of `shared/keys.ts`; no handler reads `.key`/`.code`/`.keyCode`/`.which` (the key test fails otherwise).
- UI text in sentence case; every number and ref in the monospace face (`numbered()`); colours only from `styles/tokens.css`; no endless CSS animation (a "working" indication is still, or toggled once a second by the existing counter); do not copy nerv's look (no black/red/amber, no condensed uppercase labels, no corner ticks).
- Images for the agent: long edge at most 2000 px, default 1280.
- Stage explicit paths (never `git add -A`, never `git stash`). Commit after every task, message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before a task's last commit: `pnpm -C app typecheck`, `pnpm test`, `pnpm test:kernel`, `pnpm test:e2e` green (kernel pytest only if `kernel/` changed: it should not).

## Design

### What runs

Claude Code in chat is started as the terminal one is (`claudeAdapter`: `--session-id`/`--resume`, `--mcp-config`, `--allowedTools mcp__torno__*`, `--settings` with the hooks, `--append-system-prompt`), plus:

```
-p --input-format stream-json --output-format stream-json --verbose
--include-partial-messages --permission-prompt-tool stdio
```

through `child_process.spawn` with pipes (`detached: true`, so `killGroup` can end what it started), in the object's folder, with the same environment (`agentEnv`) as a terminal session. It is the person's own `claude` under their own login: torno does not use the Agent SDK or any token of theirs.

The protocol, as `app/test/fixtures/claude-stream.jsonl` (recorded from Claude Code 2.1.300, scrubbed) shows:

- **To the CLI** (stdin, one JSON object per line):
  - a prompt: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}, {"type":"image","source":{"type":"base64","media_type":"image/png","data":"…"}}]},"parent_tool_use_id":null,"session_id":"<conversation>"}`;
  - a control request: `{"type":"control_request","request_id":"<id>","request":{"subtype":"initialize"}}` (answered with the slash commands and models there are), `{"subtype":"interrupt"}`, `{"subtype":"set_model","model":"sonnet"}` (a model for this session only: unlike `/model` it does not change the person's default);
  - the answer to a control request of the CLI's: `{"type":"control_response","response":{"subtype":"success","request_id":"<its id>","response":{"behavior":"allow","updatedInput":{…}}}}` or `{"behavior":"deny","message":"…"}`. `updatedPermissions` may carry the request's `permission_suggestions` for "Allow always".
- **From the CLI** (stdout, one JSON object per line): `system` (`init` at every prompt: model, tools, `mcp_servers` with their status; `status`; `thinking_tokens`; `compact_boundary`), `stream_event` (Anthropic streaming events: `content_block_start`/`content_block_delta` with `text_delta`, `thinking_delta`, `input_json_delta`/`content_block_stop`/`message_stop`), `assistant` (a whole message: `text`, `thinking` — whose text this CLI leaves empty —, `tool_use`), `user` (`tool_result` blocks, with `tool_use_result` holding the tool's structured result; or the text `[Request interrupted by user]`), `result` (end of a turn: `subtype` `success` or `error_during_execution`, `is_error`, `duration_ms`, `usage`), `rate_limit_event` (`rate_limit_info.unifiedWindows.five_hour.utilization`, `resetsAt`), `control_request` (`subtype: "can_use_tool"`, `tool_name`, `input`, `tool_use_id`, `permission_suggestions`), `control_response` (to ours). Anything else is passed over (counted in debug, never an error).
- Hooks fire in this mode as in the terminal: `UserPromptSubmit` (its `additionalContext` reaches the model: the probe's model quoted it back), `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`. Status and the delivery of marks keep following the hooks, unchanged.
- The CLI ends when its stdin ends.

### Rulings (binding)

1. **Chat is Claude Code's default view; the terminal stays.** `agent.json` gains `view: 'chat' | 'terminal'` (absent: `chat`; Copilot CLI is always `terminal`). The session header of Claude Code has a two-way switch "Chat · Terminal". Switching with no session changes what the next start runs. Switching with a session running asks first when it is busy (`busyWith`, as "New session" does), ends it, and resumes the same conversation in the other view. `chooseAgent`'s refusal while a session runs applies to `chooseView` too, and the window does the asking.
2. **One source for status and for marks sent:** the hooks, as now. The stream adds one thing to status: while a `can_use_tool` request of the CLI waits for the person, the status is `needs_input`; answered, `working`.
3. **What went with a prompt is shown under it.** Main records the `PromptContext` each `UserPromptSubmit` answer carried (`text` and `sentMarkIds`), and the transcript puts it under the oldest user item of that session that has none yet (prompts go to the CLI one at a time, in order). The window shows it as chips (each mark sent, by its id, in its mark colour; the build; the selection) and, opened out, the exact text in the monospace face.
4. **Every tool of torno's the agent calls is shown as torno's.** A `tool_use` named `mcp__torno__<tool>` is a torno item: its input, its result text, and its pictures (the `image` blocks of a `look`'s result) drawn as thumbnails that open larger. The turn's footer counts what was pulled from torno ("Pulled from torno: scene, 2 pictures, measure ×3"). Other tools are one line each (Read/Edit/Write: the file; Bash: the command; Grep/Glob: the pattern; Task: its description; anything else: its name), opened out to their input and result.
5. **Refs are live.** In the agent's text, in tool cards and in the context chips, every ref (`M4`, `lid/F12`, `lid/E3`, `r12`, a part name standing alone is not one) is a chip: hovering it lights it in the viewport (the agent highlight already there: `setAgentHighlight`), clicking a mark focuses it (`actions.focusMark`), clicking a face or edge selects it (`actions.setSelection`). A ref of another layout or of a part not drawn says so in its tooltip and does nothing else.
6. **Pictures and text are kept; images are not written to disk.** Main keeps every item of a running session in memory (at most 2,000 items and the 40 newest images; older images are replaced by "picture not kept"). Items that are finished are appended to `<object>/.torno/chat/<conversation>.jsonl` without their image data (`ensureIgnored(dir, ['chat/'])`, the folder checked with `ownTorno(dir, 'chat')`, writes one at a time per file). A resumed conversation in chat shows its file as "Earlier in this conversation", and says once that turns made in the terminal are not shown.
7. **Asking the person.** A `can_use_tool` request is a card in the transcript, in focus order after the last item: "Claude Code asks to use Bash", the command or input, and "Allow", "Always allow" (only when the request has `permission_suggestions`: they are passed back as `updatedPermissions`), "Deny" (with an optional reason line). `AskUserQuestion` is a question card (its `questions[]`, each with `options[]` and `multiSelect`; an "Other" line), answered with `behavior: 'allow'` and `updatedInput: {...input, answers: {<question text>: <label or labels joined by ', '>}}`. `ExitPlanMode` shows its `plan` as markdown with "Approve plan" (allow) and "Keep planning" (deny with the reason typed). A request still open when the session ends is shown "Not answered: the session ended".
8. **The composer.** A text box at the foot of the pane: Enter sends, Shift+Enter is a new line (rows of `shared/keys.ts`, scope of the composer, listed in the sheet); sending while the agent works queues the prompt (the CLI queues it; the item says "Queued" until the CLI's `init` for it). "Stop" (shown while working) sends `interrupt`. A line above the box says what goes with the next prompt, as the `nextPromptLine` does now, but as chips of the marks themselves. "Attach view" (a toggle beside the box) adds a picture of the viewport as it is now (`look`'s machinery, 1280 px long edge, the camera the person has) to the next prompt as an image block, and the user item shows it. The selection's "Insert" puts the refs in the composer at its cursor when the session is a chat. A text that begins with `/` is sent as typed; while typing a `/` command, the commands the CLI's `initialize` answered with are offered (filtered, Tab or click completes).
9. **The model.** The chat header shows the model of the session (from `init`) and offers the models `initialize` named; a choice is sent as `set_model` and never written to the person's settings.
10. **Rate limits** are one quiet line in the chat footer when `rate_limit_event` says usage is above 50 % of a window ("5-hour limit: 72 % used, resets at 18:00").
11. **No markdown library.** `ui/chat/markdown.tsx` renders the subset the agent writes: paragraphs, headings (as bold lines, no larger sizes), ordered and unordered lists (nested by indent), fenced code blocks (monospace, no highlighting, a "Copy" — no: torno never touches the clipboard; there is no copy button, text is selectable), inline code, bold, italic, links (shown as text with the URL in the monospace face; not clickable), tables (GFM pipes). Never raw HTML: everything is React text nodes.

### File structure

Main (`app/src/main/sessions/`):
- `stream.ts` — `ClaudeStream`: spawn, line framing, `prompt()`, `control()`, `answer()`, `end()`, events.
- `transcript.ts` — `Transcript`: reduces stream messages and torno's own records (prompt sent, context answered, permission asked/answered, session ended) to `ChatItem`s; caps; `toLog()`.
- `chatlog.ts` — the `.torno/chat/<conversation>.jsonl` file: append, read back.
- `manager.ts` — a session is a PTY session or a chat session (`kind`); hooks unchanged.
- `claude.ts`, `adapter.ts`, `choice.ts` — the view.

Shared: `app/src/shared/chat.ts` (types and pure helpers: `ChatItem`, `refsIn`, `toolLabel`, `pulledFromTorno`), `bridge.ts` (the `chat` calls).

Renderer (`app/src/renderer/ui/chat/`): `ChatPane.tsx`, `Items.tsx` (one component per item kind), `ToolCard.tsx`, `AskCard.tsx`, `Composer.tsx`, `RefChip.tsx`, `markdown.tsx`, `state/chat.ts` (the items per session, outside the main store: a zustand store of its own, updated by IPC; nothing per frame), `styles/chat.css` (listed in `app.css`).

Test: `app/test/fake-agent.mjs` (a stream mode), `app/test/fixtures/claude-stream.jsonl` (already there).

## Review Focus

1. **The CLI's output changes between versions.** A message type, block type or field torno does not know must never throw, stop the reader or drop the items around it. Test: the reducer fed the fixture with unknown types and fields spliced in yields the same items.
2. **A line split across reads, a very long line (a tool result of megabytes), and a non-JSON line** (the CLI prints a warning to stdout). Framing keeps going; a line over 16 MB is dropped with a note item; non-JSON is a note in debug only.
3. **The session ends with things open**: a permission card waiting, a prompt queued, a tool running, streaming text half done. Every one of them ends in a stated final state ("Not answered: the session ended", "Not sent", "Stopped"), and nothing in the window waits forever.
4. **Context matched to the wrong prompt** when two prompts are sent quickly (the second while the first works). Test: two prompts, two hook answers with different marks, each under its own prompt.
5. **The window reloads or another object is shown and back** mid-stream: the pane shows the whole transcript so far (`chat.history`) and goes on streaming; no item twice, none missing.

---

### Task 1: The stream — Claude Code started headless, in main

**Files:**
- Create: `app/src/main/sessions/stream.ts`, `app/src/main/sessions/stream.test.ts`
- Modify: `app/src/main/sessions/adapter.ts` (`LaunchContext.view`), `claude.ts` (+ `claude.test.ts`), `choice.ts` (+ `choice.test.ts`: `view`), `manager.ts` (chat sessions), `app/src/shared/bridge.ts` (`SessionView`-related types only as needed by main), `app/test/fake-agent.mjs` (stream mode), `app/src/main/sessions/manager.itest.ts` (chat cases)

**Interfaces:**
- Produces:
  - `type AgentView = 'chat' | 'terminal'` in `shared/bridge.ts`.
  - `LaunchContext.view: AgentView`; `AgentAdapter.views: AgentView[]` (`claude`: `['chat','terminal']`; `copilot`: `['terminal']`).
  - `choice.ts`: `readChoice(dir)` returns `{ agent, view, note? }` (view `chat` by default for Claude Code, always `terminal` for Copilot CLI); `writeChoice(dir, { agent, view })`.
  - `class ClaudeStream` (stream.ts):
    ```ts
    constructor(opts: { command: string; args: string[]; cwd: string; env: Record<string,string>; maxLine?: number })
    on(event: 'message', cb: (m: StreamMessage) => void): void   // every parsed line, typed loosely: { type: string; [k: string]: unknown }
    on(event: 'ask', cb: (req: { requestId: string; toolName: string; input: unknown; toolUseId?: string; suggestions?: unknown[] }) => void): void
    on(event: 'note', cb: (text: string) => void): void           // a line dropped or not JSON (debug)
    on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void
    readonly pid: number
    prompt(content: PromptBlock[], conversationId: string): void  // PromptBlock = {type:'text',text} | {type:'image',source:{type:'base64',media_type:'image/png'|'image/jpeg',data}}
    control(request: { subtype: string; [k: string]: unknown }, timeoutMs = 10_000): Promise<unknown> // resolves with response.response; rejects on error/timeout/exit
    answer(requestId: string, response: { behavior: 'allow'; updatedInput: unknown; updatedPermissions?: unknown[] } | { behavior: 'deny'; message: string }): void
    end(): void   // closes stdin; the CLI exits by itself
    ```
    `can_use_tool` requests are emitted as `ask`, not `message`. Other `control_request` subtypes from the CLI are answered `{"subtype":"error","request_id":…,"error":"not supported"}`.
  - `Sessions`: `start(obj, { resume, cols, rows })` starts the view chosen for the object. `SessionInfo`/`Started` gain `view: AgentView`. New:
    ```ts
    prompt(sessionId: string, content: PromptBlock[]): void          // chat only; rejects silently (logs) for a terminal session
    answer(sessionId: string, requestId: string, response: …): void  // chat only
    control(sessionId: string, request): Promise<unknown>            // chat only: interrupt, set_model, initialize
    ```
    and events `stream: { sessionId, objectId, message }`, `ask: { sessionId, objectId, requestId, toolName, input, toolUseId?, suggestions? }`, `context: { sessionId, objectId, text, sentMarkIds, prompt?: string }` (emitted for every `UserPromptSubmit` answered, terminal sessions too), `asked: { sessionId, requestId, answered: boolean }` (when an ask is answered or dropped at exit).
  - `stop(sessionId)` of a chat session: `end()`, then SIGTERM to the group after 2 s, SIGKILL after 4 s (`killGroup`). `write`/`resize`/`insert` are no-ops for a chat session.
  - On start a chat session sends `initialize` and keeps its answer (`Sessions.capabilities(sessionId)`: `{ commands: {name, description, argumentHint}[], models: unknown[] }`), and an `initialize` that fails or times out leaves the session working without them.

- [ ] **Step 1: fake agent stream mode.** When its argv has `--input-format stream-json`, `fake-agent.mjs` speaks the protocol (keep the terminal mode unchanged; document the new mode in its header comment):
  - answers `initialize` with `{commands:[{name:'compact',description:'Compact the conversation',argumentHint:''},{name:'clear',description:'Clear',argumentHint:''}], models:[{value:'default',displayName:'Default'},{value:'haiku',displayName:'Haiku'}]}`; `set_model` with `{}` and remembers it; `interrupt` with `{still_queued:[]}` and stops the turn in progress (emitting `user` text `[Request interrupted by user]` and a `result` with `subtype:'error_during_execution'`, `is_error:true`);
  - for each `user` message: posts `UserPromptSubmit` (body with `session_id`, `prompt` = the text) to its hook URL when `--settings` has one, then emits `system`/`init` (`model` = the set model or `fake-model`, `mcp_servers:[{name:'torno',status:'connected'}]`), then runs the prompt's script, then posts `Stop` and emits `result` (`subtype:'success'`, `is_error:false`, `duration_ms`, `usage`, `session_id`);
  - the script is the prompt text, lines of commands (anything else is answered `say` of the line):
    - `say <text>`: `stream_event`s (`message_start`, `content_block_start` text, one `text_delta` per word, 20 ms apart, `content_block_stop`, `message_stop`) then the whole `assistant` message;
    - `tool <name> <json input>`: an `assistant` message with a `tool_use` (`id: toolu_<n>`), `PreToolUse`/`PostToolUse` hooks, then a `user` `tool_result` with `content: "ran <name>"`; when `name` starts with `mcp__torno__` it calls torno's MCP server for real (the URL in `--mcp-config`, Streamable HTTP: `initialize`, then `tools/call`), and the `tool_result` content is the MCP result's `content` array as is (images included);
    - `ask <name> <json input>`: emits `control_request` `can_use_tool` (with `permission_suggestions:[{type:'addRules',rules:[{toolName:'<name>'}],behavior:'allow',destination:'session'}]`), waits for the `control_response`, then emits the tool_result `allowed: <json updatedInput>` or `denied: <message>`;
    - `slow <seconds>`: streams a word every 100 ms for that long (interruptible);
    - `rate <percent>`: emits a `rate_limit_event` with `five_hour.utilization` = percent/100;
    - `garbage`: prints a non-JSON line and an object of unknown `type`.
  - When stdin ends it posts `SessionEnd` and exits 0. On SIGTERM it exits 0.
- [ ] **Step 2: tests first for `ClaudeStream`** (`stream.test.ts`, unit, with a small node script under the test's temp dir or `fake-agent.mjs` itself): framing of a line split across chunks and of several lines in one chunk; a non-JSON line → `note`, reading goes on; a line over `maxLine` → `note`, the next line is read; `control()` resolves with the matching `request_id` only, rejects on `subtype:'error'`, on timeout, and on exit; `can_use_tool` → `ask` and `answer()` writes the exact `control_response`; `prompt()` writes the exact `user` line; `end()` → exit.
- [ ] **Step 3: implement `stream.ts`**; tests pass.
- [ ] **Step 4: adapter and choice, test first.** `claude.test.ts`: in view `chat` the argv is the terminal one plus exactly the seven flags of the Design, `-p` first after `before`; in `terminal`, unchanged. `choice.test.ts`: no file → `{agent:'claude', view:'chat'}`; `{agent:'copilot', view:'chat'}` → view `terminal`; an unknown view → `chat` with a `note`; the write is atomic and keeps the agent.
- [ ] **Step 5: manager, itest first** (`manager.itest.ts`, real HTTP router, fake agent): a chat session starts (`view: 'chat'`), `stream` events carry `init`; `prompt()` with a text gets streamed text and a `result`; the `UserPromptSubmit` hook is answered with the context (`contextFor`), `context` is emitted with that text and the mark ids, and `onDelivered` is called as for a terminal session; status goes `starting` → `working` → `idle` by the hooks; `ask` → status `needs_input`, `answer()` → the fake reports `allowed: …`, status `working`; `control({subtype:'interrupt'})` stops `slow 5` within 1 s; `stop()` ends it (exit seen; a stubborn agent is killed); the conversation is stored by the hooks as for a terminal session and `resume` passes `--resume <id>`; `write`/`insert` to a chat session write nothing; a terminal session of Claude Code is unchanged (the existing itests stay green).
- [ ] **Step 6: implement in `manager.ts`.** Keep the PTY path as it is; a `Session` gains `kind: 'pty' | 'chat'` and either `pty` or `stream`; `current()` reports `view`. `TORNO_DEBUG` prints chat command lines through `redact` as for PTY.
- [ ] **Step 7: run all four suites, commit** ("Claude Code can run headless in a chat session, beside the terminal").

### Task 2: The transcript — items, the log, and the bridge

**Files:**
- Create: `app/src/shared/chat.ts` (+ `chat.test.ts`), `app/src/main/sessions/transcript.ts` (+ `transcript.test.ts`), `app/src/main/sessions/chatlog.ts` (+ `chatlog.test.ts`)
- Modify: `app/src/main/sessions/manager.ts` (a `Transcript` per chat session; the log), `app/src/main/ipc.ts`, `app/src/shared/bridge.ts`, the preload (`app/src/preload/*`), `app/src/main/ignored.ts` callers (`chat/`), `app/src/main/sessions/manager.itest.ts`

**Interfaces:**
- Produces (`shared/chat.ts`):
  ```ts
  export type ChatItem =
    | { kind: 'user'; id: string; text: string; images: ChatImage[]; state: 'queued' | 'sent' | 'not-sent'; at: number }
    | { kind: 'context'; id: string; forUser: string; text: string; marks: string[] }      // what torno added to that prompt
    | { kind: 'text'; id: string; text: string; streaming: boolean }                       // the agent's words (markdown)
    | { kind: 'thinking'; id: string; seconds?: number; streaming: boolean }
    | { kind: 'tool'; id: string; toolUseId: string; name: string; torno: boolean; input: unknown; state: 'running' | 'done' | 'error' | 'stopped'; result?: string; images: ChatImage[]; detail?: unknown }
    | { kind: 'ask'; id: string; requestId: string; toolName: string; input: unknown; suggestions: boolean; state: 'open' | 'allowed' | 'denied' | 'ended'; answer?: string }
    | { kind: 'turn'; id: string; ok: boolean; stopped: boolean; seconds: number; pulled: Record<string, number>; error?: string }
    | { kind: 'note'; id: string; text: string; tone: 'quiet' | 'warn' }                    // started, model, torno tools not connected, earlier conversation, terminal turns not shown, session ended
  export interface ChatImage { id: string; mediaType: string; data?: string /* base64; absent once not kept */; width?: number; height?: number }
  export interface ChatMeta { model?: string; tornoConnected?: boolean; rate?: { window: string; used: number; resetsAt?: number } }
  export function refsIn(text: string): Array<{ text: string; ref?: string }>   // splits text into plain pieces and refs (M4, r12, part/F3, part/E7) — the same pattern as numbered()'s refs
  export function toolLabel(name: string, input: unknown): string               // "Read app.py", "Bash: uv run pytest", "torno · look (iso)", …
  export function pulledFromTorno(pulled: Record<string, number>): string | null // "Pulled from torno: scene, 2 pictures, measure ×3"
  ```
- `Transcript` (main):
  ```ts
  constructor(opts: { maxItems?: number /*2000*/; maxImages?: number /*40*/ })
  userSent(content: PromptBlock[], queued: boolean): ChatItem          // a user item
  context(c: { text: string; sentMarkIds: string[] }): ChatItem | null  // under the oldest user item without one
  message(m: StreamMessage): ChatItem[]                                 // items added or changed by one CLI message
  asked(a: …): ChatItem; answered(requestId, state, answer?): ChatItem | null
  ended(): ChatItem[]                                                   // closes everything open (Review Focus 3)
  items(): ChatItem[]; meta(): ChatMeta
  ```
  Items are upserted by `id`; a change re-emits the whole item. Streaming text changes are coalesced: at most one emit per item per 50 ms (the last one always goes).
- Bridge (`shared/bridge.ts`, a `chat` group; preload and `ipc.ts` to match):
  ```ts
  chat: {
    history(sessionId: string): Promise<{ items: ChatItem[]; meta: ChatMeta; earlier: ChatItem[]; commands: Array<{name: string; description: string; argumentHint: string}>; models: Array<{value: string; displayName: string}> }>
    onItem(cb: (m: { sessionId: string; item: ChatItem }) => void): () => void
    onMeta(cb: (m: { sessionId: string; meta: ChatMeta }) => void): () => void
    send(sessionId: string, prompt: { text: string; attachView?: boolean }): Promise<void>  // main makes the picture when attachView (through the window's look, as the agent's look does)
    answer(sessionId: string, requestId: string, answer: { allow: true; always?: boolean; updatedInput?: unknown } | { allow: false; message: string }): void
    interrupt(sessionId: string): Promise<void>
    setModel(sessionId: string, model: string): Promise<void>
  }
  session.chooseView(objectId: string, view: AgentView): Promise<void>   // rejects while a session runs, as chooseAgent
  ```
  Calls for a session not of the open workspace are refused as `session.write` is (`sessionOfWorkspace`). `updatedInput` is accepted only for `AskUserQuestion` (answers) — for any other tool main answers with the request's own input.
- `chatlog.ts`: `appendItems(dir, conversationId, items)` (one write at a time per file, `ownTorno(dir, 'chat')` before the first, `ensureIgnored(dir, ['chat/'])`, images stripped of `data`), `readLog(dir, conversationId, limit = 500)` (last `limit` items; a bad line is skipped). An item is appended when it is final (user once sent, text when not streaming, tool when not running, ask when not open, turn, context, note).

- [ ] **Step 1: tests first for the reducer**, fed `app/test/fixtures/claude-stream.jsonl`: the items are, in order, user? (none: the fixture has no prompts of ours — feed `userSent` for the three prompts at the points the `init`s come), tool Bash (`cat note.txt`, done, result `hello`), text (the reply, ending "…not from `note.txt`."), turn ok; tool Write (done), text, turn ok; tool Bash (`seq 1 200`, then `stopped`), turn stopped. Streaming: the text item exists with `streaming: true` after the first `text_delta`, and its text grows. Unknown `type`s and fields spliced in change nothing (Review Focus 1). A `tool_use` named `mcp__torno__look` whose result has two `image` blocks gives `torno: true`, two images, and the turn's `pulled` `{look: 1, pictures: 2}`. `context()` with two prompts sent before either hook: each context under its own prompt (Review Focus 4). `ended()` with an ask open, a tool running and text streaming: `ended`, `stopped`, `streaming: false`, plus a note "The session ended". Caps: the 41st image drops the oldest one's `data`; the 2,001st item drops the oldest item.
- [ ] **Step 2: implement `shared/chat.ts` (with its tests: `refsIn` on `M4 and lid/F12, r3; tub_2/E10.` and never on `M` alone, `F12` alone, `3.5`) and `transcript.ts`.**
- [ ] **Step 3: tests then implementation for `chatlog.ts`** (temp dir; a symlinked `.torno/chat` refused; images stripped; bad line skipped; `.gitignore` gets `chat/`).
- [ ] **Step 4: wire into the manager and IPC, itest first**: a chat session's `stream`/`context`/`ask` events become items (`chat:item` IPC); `history()` mid-stream returns the items so far and the next `onItem`s continue it with no duplicate (Review Focus 5); a resumed conversation's `history().earlier` holds the logged items and a note; `send` with `attachView` adds an image block (in itest, stub the window's picture with a 4×4 PNG); the `context` item for a prompt carries the mark ids `onDelivered` was given.
- [ ] **Step 5: four suites, commit** ("A chat session keeps a transcript: what was said, what torno added, every tool it used").

### Task 3: The chat pane

**Files:**
- Create: `app/src/renderer/ui/chat/ChatPane.tsx`, `Items.tsx`, `ToolCard.tsx`, `Composer.tsx`, `RefChip.tsx`, `markdown.tsx` (+ `markdown.test.ts`), `app/src/renderer/state/chat.ts` (+ `chat.test.ts`), `app/src/renderer/styles/chat.css`, `app/e2e/chat.spec.ts`
- Modify: `app/src/renderer/ui/SessionPane.tsx` (the chat pane in place of the terminal host when the session's view is chat; the "Chat · Terminal" switch in the header for Claude Code; Insert → composer), `app/src/renderer/styles/app.css` (list `chat.css`), `app/src/shared/keys.ts` (+ test, + README key table via `TORNO_README=write`), `app/src/renderer/state/store.ts` (`SessionView.view`)

**What the pane is (design):** a column the width of the session pane. From the top: the header (as now, plus the switch and, in chat, the model); the transcript, scrolled to its end while it was at its end (a person who scrolled up is not pulled down; a quiet "New messages below" button brings them down); at the foot, the "goes with your next prompt" line of chips, then the composer. The transcript reads as a document, not bubbles: a user prompt is a block on `--accent-wash` with the text in ink; under it, when torno added something, one line "torno added" followed by chips (each mark id in its colour, `r12 ok`/`r12 failed`, `selection: lid/F12`) and an opener for the exact text. The agent's text is plain on the panel. A tool is one line (an icon-free label from `toolLabel`, a state word: running / done / failed / stopped) that opens to its input and result (monospace, the first 12 lines, "Show all"); a torno tool has a thin left rule in `--accent` and its pictures shown under the line as thumbnails (up to 3 in a row, 96 px high, click to view at the pane's width; Escape or click closes). Each turn ends with a quiet footer: "Done in 12 s · Pulled from torno: scene, 2 pictures" or "Stopped" or "Failed: <error>". Nothing animates without end: a running tool and a streaming text show a still dot that the existing one-second counter toggles (as the build dot does).

- [ ] **Step 1: tests first for `markdown.tsx`** (vitest, render to a string with `react-dom/server`): every construct of Design ruling 11, a `<script>` in the text shown as text, a 2,000-line code block rendered without nesting blowups, refs in text become `RefChip` (not inside code).
- [ ] **Step 2: implement `markdown.tsx` and `RefChip.tsx`** (hover → the viewport's agent highlight for that ref; leave → off; click → `focusMark` or `setSelection`; a ref not in the shown layout: a tooltip saying so, nothing else).
- [ ] **Step 3: `state/chat.ts` test first**: items per session upserted by id; `history()` replaces; an `onItem` before `history()` resolves is not lost (buffer then merge by id); a session's items dropped when the workspace closes.
- [ ] **Step 4: the pane, the items, the composer, the switch.** Keys: add rows to `shared/keys.ts` for the composer's send (Enter) and new line (Shift+Enter) in a scope of the composer, and for closing an enlarged picture (Escape); the key test and the README table (`TORNO_README=write pnpm -C app exec vitest run src/readme.test.ts`) follow. The composer keeps the keys while in focus (`TYPING`), Escape gives them back to the view (`giveKeysBack`) as a field does. `` Ctrl+` `` moves to the composer in place of the terminal.
- [ ] **Step 5: e2e `chat.spec.ts`** (hidden window, fake agent in stream mode, temp copy of a fixture object): start → the pane is a chat (no `.xterm`); type `say hello there` + Enter → a user item, then the text "hello there" streamed, then a turn footer "Done in"; with a draft mark M1 present, the prompt's "torno added" shows a chip `M1` and the mark is `sent` in the Marks panel; `tool mcp__torno__look {"view":"iso"}` → a torno tool line with one thumbnail (the real `look` of the fixture object, through the real MCP server) and the footer says "Pulled from torno: look, 1 picture"; hovering the `M1` chip lights the mark (assert the store's agent highlight), clicking it makes it the active mark; `slow 5` then Stop → "Stopped" within 2 s; the switch to Terminal ends the session and starts a terminal one with `--resume` (fake's READY line), and back to Chat shows "Earlier in this conversation" with the earlier items; reload of the window mid-`slow 3` shows every item once.
- [ ] **Step 6: four suites, commit** ("Claude Code talks in a pane of torno's own: what torno added and every torno tool are shown").

### Task 4: Asking, attaching, commands, model

**Files:**
- Create: `app/src/renderer/ui/chat/AskCard.tsx`, `app/e2e/chatask.spec.ts`
- Modify: `ChatPane.tsx`, `Composer.tsx`, `Items.tsx`, `chat.css`, `app/src/main/ipc.ts` (attachView picture), `app/src/renderer/closing.ts` (+ test: an open ask is something a close cuts short: "Claude Code is waiting for your answer" — already covered by `needs_input`; make sure), `app/src/renderer/state/chat.ts`

- [ ] **Step 1: e2e first** (`chatask.spec.ts`): `ask Bash {"command":"ls"}` → a card "Claude Code asks to use Bash" with `ls`, the session status "Needs input"; "Allow" → the fake's `allowed: {"command":"ls"}`, the card says "Allowed", status back to working then idle; again with "Deny" and a reason → `denied: <reason>`; "Always allow" sends `updatedPermissions` (the fake prints them); `ask AskUserQuestion {"questions":[{"question":"Which wall?","header":"Wall","multiSelect":false,"options":[{"label":"2 mm","description":"thin"},{"label":"3 mm","description":"thick"}]}]}` → a question card; choosing "3 mm" → the fake prints `allowed:` with `answers: {"Which wall?":"3 mm"}`; `ask ExitPlanMode {"plan":"# Plan\n- a"}` → the plan drawn as markdown, "Keep planning" with a reason → denied with it; an ask open when the session is ended → "Not answered: the session ended"; "Attach view" on, prompt sent → the user item shows a thumbnail and the fake reports an image block of a PNG whose long edge is 1280; typing `/co` offers `compact` and Tab completes it to `/compact `; the model menu lists Default and Haiku, choosing Haiku sends `set_model` (the next `init` says `haiku`) and the person's settings file is not written (the test's HOME is a temp dir: assert nothing was written under it); `rate 72` → the footer line "5-hour limit: 72 % used".
- [ ] **Step 2: implement** the cards (keys: the card's buttons are buttons; Enter on a focused button is the browser's; no new key unless needed — then a row in `keys.ts`), attach view (main asks the window for a picture as `look` does, with the person's camera, 1280 px, PNG), commands, model, rate line.
- [ ] **Step 3: four suites, commit** ("The chat asks, attaches the view, completes commands and changes the model of a session").

### Task 5: Docs and the last pass

**Files:** `README.md`, `CLAUDE.md`, `app/src/main/CLAUDE.md`, `app/src/renderer/CLAUDE.md`, `app/e2e/CLAUDE.md` (the stream mode of the fake agent), `app/src/readme.test.ts` if a heading is added.

- [ ] README: the session section says Claude Code opens in a chat by default, what the chat shows (torno added; tools pulled from torno; refs live; asking; attach view; commands; model only for the session), the switch to the terminal (same conversation), what is kept in `.torno/chat/` (ignored, text only, pictures not kept), the table of `.torno` files gains `chat/`; "Not yet verified on a visible screen" gains: the chat with the real Claude Code (a prompt, a permission card, a question, attach view, the model menu, switching to the terminal and back).
- [ ] Root `CLAUDE.md` "What crosses processes": one bullet for the chat (the stream is the CLI's own headless mode; hooks stay the one source of status and of marks sent; `.torno/chat/` holds no address and no image). `app/src/main/CLAUDE.md` Agents: the chat session, the transcript, the log. `app/src/renderer/CLAUDE.md`: the chat pane, its keys, refs as chips.
- [ ] Four suites, commit ("README and CLAUDE.md say how the chat works").

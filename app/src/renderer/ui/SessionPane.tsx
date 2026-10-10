import { hint, keyName, pressed } from '../../shared/keys'
import { useEffect, useMemo, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { type ITheme, Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { type SessionSaid, AGENT_LABEL, busyWith, nextCarries, nextPromptLine, sendLabel, sessionSaid, toldLine, toSend } from '../../shared/agents'
import type { AgentId } from '../../shared/bridge'
import { actions, store, useStore } from '../state/store'
import { type AgentChoice, AgentPicker } from './AgentPicker'
import { Confirm } from './Confirm'
import { numbered } from './numbered'

const FONT_SIZE = 13

const STATUS_WORD: Record<SessionSaid, string> = {
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  needs_input: 'Needs input',
  // Of an agent that posts no hooks: nothing says whether it is at work.
  running: 'Running',
  exited: 'Ended'
}

/** Until main has said which are installed. */
const AGENTS: AgentChoice[] = [
  { id: 'claude', label: AGENT_LABEL.claude, installed: true, hooks: true },
  { id: 'copilot', label: AGENT_LABEL.copilot, installed: true, hooks: false }
]

const SEND_TITLE = 'Writes .torno/prompt.md and puts a line at the cursor for you to send'

// ---- Terminals ----
//
// One terminal per object that has had a session, kept for as long as its
// workspace is open, so that going to another object and back finds the
// session as it was. Each lives in an element of its own, which is put into the
// pane while its object is the one shown. The agent's output is written
// straight into it and never passes through React or the store.

interface ObjectTerminal {
  term: Terminal
  fit: FitAddon
  element: HTMLDivElement
  /** The session whose output it shows and which gets what is typed; null between sessions. */
  sessionId: string | null
  /** The GPU renderer, only while the terminal is in the pane. */
  webgl: WebglAddon | null
}

const terminals = new Map<string, ObjectTerminal>() // by object id

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const

/** The terminal's colours, from the tokens as the colour scheme has them now. */
function readTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string) => style.getPropertyValue(name).trim()
  const theme: ITheme = {
    background: token('--panel'),
    foreground: token('--ink'),
    cursor: token('--ink'),
    cursorAccent: token('--panel'),
    selectionBackground: token('--term-selection'),
    // Whatever colour the agent's CLI gave it: selected, a text is read on the selection, in ink.
    selectionForeground: token('--ink'),
    selectionInactiveBackground: token('--term-selection'),
    scrollbarSliderBackground: token('--term-scroll'),
    scrollbarSliderHoverBackground: token('--term-scroll-hover'),
    scrollbarSliderActiveBackground: token('--term-scroll-hover')
  }
  for (const name of ANSI) {
    theme[name] = token(`--ansi-${name}`)
    theme[`bright${name[0].toUpperCase()}${name.slice(1)}` as 'brightBlack'] = token(`--ansi-bright-${name}`)
  }
  return theme
}

let monoLoaded: Promise<unknown> | null = null

/** The terminal measures its cells when it opens, so its typeface must be there by then. */
function monoFont(): Promise<unknown> {
  monoLoaded ??= Promise.all(
    ['400', '500'].map((weight) => document.fonts.load(`${weight} ${FONT_SIZE}px "IBM Plex Mono"`))
  ).catch(() => {})
  return monoLoaded
}

function terminalFor(objectId: string): ObjectTerminal {
  const existing = terminals.get(objectId)
  if (existing) return existing

  const term = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
    fontSize: FONT_SIZE,
    fontWeight: '400',
    fontWeightBold: '500',
    lineHeight: 1.25,
    scrollback: 5000,
    cursorBlink: false,
    cursorInactiveStyle: 'outline',
    // The agent chooses its own colours without knowing the ground they land on.
    minimumContrastRatio: 4.5,
    theme: readTheme()
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  const element = document.createElement('div')
  element.className = 'session-term-mount'
  const t: ObjectTerminal = { term, fit, element, sessionId: null, webgl: null }

  term.onData((data) => {
    if (t.sessionId) window.torno.session.write(t.sessionId, data)
  })
  // Fires only when the size really changes.
  term.onResize(({ cols, rows }) => {
    if (t.sessionId) window.torno.session.resize(t.sessionId, cols, rows)
  })
  term.attachCustomKeyEventHandler((e) => {
    if (pressed(e, 'session.newline')) {
      // A new line in the agent's prompt, not a submit. Every stage of the key
      // is taken from the terminal, or its text field would add a line break of its own.
      e.preventDefault()
      if (e.type === 'keydown' && t.sessionId) window.torno.session.write(t.sessionId, '\x1b\r')
      return false
    }
    const copy = pressed(e, 'session.copy')
    if (copy || pressed(e, 'session.paste')) {
      e.preventDefault()
      if (e.type !== 'keydown') return false
      if (copy) {
        const selected = term.getSelection()
        if (selected) void navigator.clipboard.writeText(selected).catch(() => {})
      } else {
        // As a paste, so the agent takes it as text and submits nothing.
        void navigator.clipboard.readText().then(
          (text) => text && term.paste(text),
          () => {}
        )
      }
      return false
    }
    return true
  })

  terminals.set(objectId, t)
  return t
}

function fitTerminal(t: ObjectTerminal): void {
  const host = t.element.parentElement
  // A hidden dock has no size; the terminal keeps the one it had.
  if (!host || host.clientWidth === 0 || host.clientHeight === 0) return
  const size = t.fit.proposeDimensions()
  if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return
  if (size.cols !== t.term.cols || size.rows !== t.term.rows) t.term.resize(size.cols, size.rows)
}

/** Put a terminal into the pane, drawn on the GPU when that works, and fit it. */
function mount(t: ObjectTerminal, host: HTMLElement): void {
  if (t.element.parentElement !== host) {
    host.replaceChildren(t.element)
    if (!t.term.element) t.term.open(t.element)
  }
  if (!t.webgl) {
    // The window holds other WebGL contexts (the viewport). If this one cannot
    // be had, or is lost later, the terminal draws with its default renderer.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl.dispose()
        if (t.webgl === webgl) t.webgl = null
      })
      t.term.loadAddon(webgl)
      t.webgl = webgl
    } catch {
      t.webgl = null
    }
  }
  fitTerminal(t)
}

function unmount(t: ObjectTerminal): void {
  t.webgl?.dispose()
  t.webgl = null
  t.element.remove()
}

function disposeTerminals(): void {
  for (const t of terminals.values()) {
    unmount(t)
    t.term.dispose()
  }
  terminals.clear()
}

/** What an IPC call failed with, without Electron's wrapping. */
function reason(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
}

// ---- The pane ----

/**
 * The agent's session for the open object: the real CLI in a terminal, with
 * its status in the header. `onReveal` opens the dock when the keyboard asks
 * for the session while it is hidden.
 */
export function SessionPane({ onReveal }: { onReveal: () => void }) {
  const root = useStore((s) => s.workspace?.root)
  const objectId = useStore((s) => s.objectId)
  const objectName = useStore((s) => s.workspace?.objects.find((o) => o.id === s.objectId)?.name ?? s.objectId)
  const session = useStore((s) => (s.objectId ? s.sessions[s.objectId] : undefined))
  const marks = useStore((s) => s.marks)
  const revision = useStore((s) => s.revision)
  const [resumable, setResumable] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  /** Whether "New session" is waiting for a yes: the session it would end is in the middle of something. */
  const [asking, setAsking] = useState(false)
  /** The agent the object's next session runs, as its `.torno/agent.json` has it; `note` when that file could not be followed. */
  const [choice, setChoice] = useState<{ agent: AgentId; note?: string }>({ agent: 'claude' })
  const [agents, setAgents] = useState<AgentChoice[]>(AGENTS)
  /** The agent chosen while a session runs, waiting for a yes: choosing it ends that session. */
  const [choosing, setChoosing] = useState<AgentId | null>(null)
  /** Counted up when the choice was written, so that what main has for the object is asked again. */
  const [chosen, setChosen] = useState(0)
  const [sending, setSending] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  const reveal = useRef(onReveal)
  reveal.current = onReveal

  // Main's side of the sessions, the colour scheme, and the key that goes between viewport and session.
  useEffect(() => {
    const offData = window.torno.session.onData(({ sessionId, data }) => {
      for (const t of terminals.values()) if (t.sessionId === sessionId) t.term.write(data)
    })
    const offSend = window.torno.session.onSend((m) => actions.applySend(m))
    const offStatus = window.torno.session.onStatus((m) => {
      actions.applySessionStatus(m)
      if (m.status !== 'exited') return
      // What it last said stays to be read; nothing more can be typed into it.
      for (const t of terminals.values()) if (t.sessionId === m.sessionId) t.term.options.disableStdin = true
    })

    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    const onScheme = () => {
      const theme = readTheme()
      for (const t of terminals.values()) t.term.options.theme = theme
    }
    scheme.addEventListener('change', onScheme)

    const shown = () => [...terminals.values()].find((t) => t.element.parentElement === host.current)

    // Ctrl+`: from anywhere to the session, and from the session back to the viewport.
    const onKey = (e: KeyboardEvent) => {
      if (keyName(e) !== hint('session.focus')) return
      e.preventDefault()
      e.stopPropagation()
      const dock = host.current?.closest('[data-region="session"]')
      const active = document.activeElement
      if (dock && active instanceof HTMLElement && dock.contains(active)) {
        active.blur()
        return
      }
      reveal.current()
      // Once the dock is laid out again.
      requestAnimationFrame(() => {
        const t = shown()
        if (t) t.term.focus()
        else dock?.querySelector<HTMLElement>('button:not([disabled])')?.focus()
      })
    }
    window.addEventListener('keydown', onKey, true)

    // The dock is resized and hidden by its own controls; the terminal follows its box.
    let frame = 0
    const sized = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const t = shown()
        if (t) fitTerminal(t)
      })
    })
    sized.observe(host.current!)

    if (new URLSearchParams(location.search).has('test')) {
      window.__tornoTerm = {
        text() {
          const t = shown()
          if (!t) return ''
          const buffer = t.term.buffer.active
          // A line the terminal wrapped is one line again here.
          let all = ''
          for (let y = 0; y < buffer.length; y += 1) {
            const line = buffer.getLine(y)
            if (!line) continue
            all += `${line.isWrapped || y === 0 ? '' : '\n'}${line.translateToString(!buffer.getLine(y + 1)?.isWrapped)}`
          }
          return all.trimEnd()
        },
        size() {
          const t = shown()
          return t ? { cols: t.term.cols, rows: t.term.rows } : null
        },
        theme() {
          const theme = shown()?.term.options.theme
          return { background: theme?.background, foreground: theme?.foreground }
        },
        renderer() {
          const t = shown()
          return t ? (t.webgl ? 'webgl' : 'dom') : null
        }
      }
    }

    return () => {
      offData()
      offSend()
      offStatus()
      scheme.removeEventListener('change', onScheme)
      window.removeEventListener('keydown', onKey, true)
      cancelAnimationFrame(frame)
      sized.disconnect()
      delete window.__tornoTerm
    }
  }, [])

  // Main ends the sessions of a workspace when it is closed; their terminals go with it.
  useEffect(() => disposeTerminals, [root])

  // The terminal of the object shown is the one in the pane.
  useEffect(() => {
    setProblem(null)
    setAsking(false)
    setChoosing(null)
    setChoice({ agent: 'claude' })
    if (!objectId) return
    const mine = terminals.get(objectId)
    if (mine) mount(mine, host.current!)
    return () => {
      const t = terminals.get(objectId)
      if (t) unmount(t)
    }
  }, [objectId, root])

  // What main has for this object: whether a conversation can be resumed (it is
  // put on file by the first prompt), and a session that was already running
  // when this window was loaded. Of that one, only what it says from now on is seen.
  const status = session?.status
  useEffect(() => {
    if (!objectId) return
    let live = true
    void Promise.all([window.torno.session.current(objectId), monoFont()]).then(
      ([info]) => {
        if (!live) return
        setResumable(info.resumable)
        setChoice({ agent: info.agent, ...(info.note ? { note: info.note } : {}) })
        if (!info.running || store.getState().sessions[objectId]) return
        const t = terminalFor(objectId)
        t.sessionId = info.running.sessionId
        actions.setSession(objectId, info.running)
        mount(t, host.current!)
        window.torno.session.resize(info.running.sessionId, t.term.cols, t.term.rows)
      },
      () => {}
    )
    return () => {
      live = false
    }
  }, [objectId, root, status, chosen])

  // Which agents are installed: asked for each object shown, and again whenever the list is opened.
  const askAgents = (): void => void window.torno.session.agents().then(setAgents, () => {})
  useEffect(() => {
    if (objectId) askAgents()
  }, [objectId, root])

  // A session just started takes the keyboard, once its terminal is no longer hidden.
  const focusWanted = useRef(false)
  const sessionId = session?.sessionId
  useEffect(() => {
    if (!focusWanted.current || !objectId || !sessionId) return
    focusWanted.current = false
    terminals.get(objectId)?.term.focus()
  }, [objectId, sessionId])

  async function start(resume: boolean): Promise<void> {
    if (!objectId || starting) return
    setStarting(true)
    setProblem(null)
    try {
      await monoFont()
      // A new session takes the place of the one running.
      const previous = store.getState().sessions[objectId]
      if (previous && previous.status !== 'exited') void window.torno.session.stop(previous.sessionId).catch(() => {})
      const t = terminalFor(objectId)
      t.sessionId = null
      t.term.reset()
      t.term.options.disableStdin = false
      const shown = store.getState().objectId === objectId && host.current
      // Fitted first, so the agent starts at the size it will be shown at.
      if (shown) mount(t, shown)
      const started = await window.torno.session.start(objectId, { resume, cols: t.term.cols, rows: t.term.rows })
      t.sessionId = started.sessionId
      // As main has it: a session that was already running here is not starting, and may say nothing more for a while.
      actions.setSession(objectId, { sessionId: started.sessionId, status: started.status, agent: started.agent, hooks: started.hooks })
      focusWanted.current = true
    } catch (e) {
      setProblem(reason(e))
    } finally {
      setStarting(false)
    }
  }

  const ended = status === 'exited'
  const busy = session ? busyWith(session.status, session.hooks) : undefined
  /** The agent of the session shown; of none, the one a new session would run. */
  const agentLabel = AGENT_LABEL[session?.agent ?? choice.agent]
  // What an agent without hooks has not been told: there is a button for it only while there is something.
  const unsent = useMemo(() => toSend(marks, revision > 0 ? revision : undefined), [marks, revision])
  const send = sendLabel(unsent)
  const told = session && !ended && !session.hooks
  // For an agent that is told with every prompt: what the next one carries, said in one quiet line. Of the
  // session there is; with none, of the agent a new one would run.
  const live = session !== undefined && !ended
  const withHooks = live ? session.hooks : (agents.find((one) => one.id === choice.agent)?.hooks ?? false)
  const next = useMemo(() => (objectId && withHooks ? nextPromptLine(nextCarries(marks, revision > 0 ? revision : undefined), live) : null), [objectId, withHooks, marks, revision, live])

  /** Write the file and put the line that names it at the agent's cursor, where the person's Enter sends it. */
  async function sendMarks(): Promise<void> {
    if (!objectId || !session || sending) return
    setSending(true)
    setProblem(null)
    try {
      await window.torno.session.sendMarks(session.sessionId)
      terminals.get(objectId)?.term.focus()
    } catch (e) {
      setProblem(reason(e))
    } finally {
      setSending(false)
    }
  }

  /** Keep another agent for the object's sessions to come. One that runs is ended first, and none is started. */
  async function applyChoice(agent: AgentId): Promise<void> {
    if (!objectId) return
    setProblem(null)
    try {
      const live = store.getState().sessions[objectId]
      if (live && live.status !== 'exited') await window.torno.session.stop(live.sessionId)
      await window.torno.session.chooseAgent(objectId, agent)
      if (store.getState().objectId === objectId) setChoice({ agent })
    } catch (e) {
      setProblem(reason(e))
    } finally {
      setChosen((n) => n + 1)
    }
  }

  /** Another agent was picked: asked about first while a session runs, since it ends that one. */
  function choose(agent: AgentId): void {
    if (agent === choice.agent && !choice.note) return
    if (session && !ended) setChoosing(agent)
    else void applyChoice(agent)
  }

  /** A new session in place of the one running, asked about first if that one is in the middle of something. */
  function startNew(): void {
    if (busy) setAsking(true)
    else void start(false)
  }

  function keepSession(): void {
    setAsking(false)
    if (objectId) terminals.get(objectId)?.term.focus()
  }

  return (
    <>
      <header className="panel-head session-head">
        <h2 className="panel-title">{objectId ? agentLabel : 'Session'}</h2>
        {session && (
          <span className="session-status" role="status" data-status={sessionSaid(session.status, session.hooks)}>
            <span className="status-dot" />
            {STATUS_WORD[sessionSaid(session.status, session.hooks)]}
          </span>
        )}
        <span className="spacer" />
        {objectId && <AgentPicker value={choice.agent} agents={agents} disabled={starting || asking || choosing !== null} onOpen={askAgents} onChoose={choose} />}
        {session && (
          <>
            {ended && resumable && (
              <button type="button" className="button button-quiet" disabled={starting} onClick={() => void start(true)}>
                Resume
              </button>
            )}
            <button type="button" className="button button-quiet" disabled={starting || asking} onClick={startNew}>
              New session
            </button>
          </>
        )}
      </header>

      {/* An agent that posts no hooks is told nothing with a prompt: said here, with the button that tells it. */}
      {told && (
        <div className="session-told">
          <p aria-live="polite">{toldLine(session.send, unsent.drafts)}</p>
          {send && (
            <button type="button" className="button session-send" title={SEND_TITLE} disabled={sending} onClick={() => void sendMarks()}>
              {send.text} (<span className="num">{send.count}</span>)
            </button>
          )}
        </div>
      )}
      {next !== null && (
        <p className="session-next" role="status">
          {numbered(next)}
        </p>
      )}
      {choice.note && objectId && (
        <div className="session-told">
          <p role="note">{choice.note}</p>
          {/* Claude Code is already what the list shows: choosing it there changes nothing, so it is chosen here. */}
          <button type="button" className="button session-send" disabled={starting || choosing !== null} onClick={() => choose('claude')}>
            Use {AGENT_LABEL.claude}
          </button>
        </div>
      )}

      <div className="session-body">
        {asking && session && (
          <Confirm
            label="End the running session?"
            accept="End it and start new"
            cancel="Keep it"
            onCancel={keepSession}
            onAccept={() => {
              setAsking(false)
              void start(false)
            }}
          >
            {agentLabel} {busy ?? 'is running'}. A new session ends this one.
          </Confirm>
        )}
        {choosing !== null && session && (
          <Confirm
            label="End the running session?"
            accept={`End it and choose ${AGENT_LABEL[choosing]}`}
            cancel="Keep it"
            onCancel={() => {
              setChoosing(null)
              keepSession()
            }}
            onAccept={() => {
              const agent = choosing
              setChoosing(null)
              void applyChoice(agent)
            }}
          >
            {agentLabel} {busy ?? 'is running'}. Choosing another agent ends this session, and starts none.
          </Confirm>
        )}
        {/* Always laid out, so a terminal can be fitted before its session starts. */}
        <div className="session-term" ref={host} data-shown={session ? '' : undefined} />
        {!objectId ? (
          <p className="panel-note">Open an object to work on it with the agent.</p>
        ) : (
          !session && (
            <div className="session-empty">
              <div className="session-actions">
                <button type="button" className="button button-primary" disabled={starting} onClick={() => void start(false)}>
                  New session
                </button>
                {resumable && (
                  <button type="button" className="button session-resume" disabled={starting} onClick={() => void start(true)}>
                    Resume
                  </button>
                )}
              </div>
              <p>
                {agentLabel} runs here, in the folder of {objectName}, and works on it with you.
              </p>
            </div>
          )
        )}
        {problem !== null && objectId && (
          <p className="session-problem selectable" role="alert">
            {problem}
          </p>
        )}
      </div>
    </>
  )
}

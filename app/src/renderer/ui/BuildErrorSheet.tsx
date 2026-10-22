import { hint, pressed } from '../../shared/keys'
import { useEffect, useRef, useState } from 'react'
import { type BuildError, kindWords, fixPrompt, rebuildHelps, stillLatest } from '../../shared/build'
import { WHY, diagnosisText } from '../../shared/diagnosis'
import { useChat } from '../state/chat'
import { actions, runningSession, useStore } from '../state/store'
import { insertIntoSession } from './insertIntoSession'

/** Everything the kernel said about a failed build, as one text to paste elsewhere: why a fillet failed after the message. */
export function errorText(error: BuildError): string {
  return [error.message, error.diagnosis && diagnosisText(error.diagnosis), error.traceback, error.output]
    .map((part) => part?.trimEnd())
    .filter(Boolean)
    .join('\n\n')
}

/** How Claude Code gets to know of the failure: after its own edit, with the next prompt, or (no session runs) with the first prompt of the next one. */
export type Told = 'edit' | 'prompt' | 'none'

/** The lead of the sheet: who is told, so that the person need not paste the error into the chat. */
export function toldLine(told: Told): string {
  if (told === 'edit') return 'Claude Code was told after its edit, and your next prompt carries it too.'
  if (told === 'prompt') return 'Claude Code is told this with your next prompt.'
  return 'No session is running. Start one, and it is told with your first prompt.'
}

/** The words on the button that hands the error over, for what it does now. */
export function askLabel(told: Told): string {
  return told === 'none' ? 'Start a session to fix it' : 'Ask Claude Code to fix it'
}

/**
 * The failed build in full: message, why a fillet or a chamfer failed (when the kernel found out), traceback and
 * what the model printed. It
 * rises from the status line over the viewport; the parts of the last good
 * build stay visible above it.
 */
export function BuildErrorSheet({ objectName, error, onClose }: { objectName: string; error: BuildError; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  /** What "Ask Claude Code to fix it" did a moment ago: put the words in the box, or asked for a session that will. */
  const [handed, setHanded] = useState<'box' | 'start' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const build = useStore((st) => st.build)
  const objectId = useStore((st) => st.objectId)
  const session = useStore(runningSession)
  const chat = useChat(session?.view === 'chat' ? session.sessionId : undefined)
  const told: Told = !session ? 'none' : chat?.items.some((i) => i.kind === 'context' && i.forTool && stillLatest(build, i)) ? 'edit' : 'prompt'
  const retry = build !== null && rebuildHelps(build)
  const body = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (pressed(e, 'sheet.close')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    if (handed === null) return
    const timer = setTimeout(() => setHanded(null), 1600)
    return () => clearTimeout(timer)
  }, [handed])

  /** Fills the message box of the object's session with a request to fix the build, and shows it. Never sends it. */
  function ask(): void {
    const text = fixPrompt(objectName)
    setProblem(null)
    actions.setDockOpen(true)
    if (!session) {
      // The session pane starts one and leaves the words in its box.
      actions.setFixRequest(text)
      setHanded('start')
      return
    }
    if (!insertIntoSession(text, { later: true })) return setProblem('The message box is not open.')
    setHanded('box')
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(errorText(error))
    } catch {
      // No clipboard access (the window is not focused): copy the text as shown.
      const selection = getSelection()
      selection?.selectAllChildren(body.current!)
      document.execCommand('copy')
      selection?.removeAllRanges()
    }
    setCopied(true)
  }

  return (
    <section className="sheet" role="dialog" aria-label="Build error">
      <header className="sheet-head">
        <h2 className="sheet-title">{objectName} did not build</h2>
        <span className="spacer" />
        {/* After a failure outside the model building again is what may help; after an error in it, asking for the fix is. */}
        {retry && (
          <button type="button" className="button button-primary" onClick={() => objectId !== null && void window.torno.object.rebuild(objectId).catch(() => {})}>
            Rebuild
          </button>
        )}
        <button type="button" className={retry ? 'button' : 'button button-primary'} data-part="ask" onClick={ask}>
          {handed === 'box' ? 'In the message box' : handed === 'start' ? 'Starting a session…' : askLabel(told)}
        </button>
        <button type="button" className="button button-quiet" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="icon-button" aria-label="Close" title={`Close (${hint('sheet.close')})`} onClick={onClose}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden="true">
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div className="sheet-lead" data-kind={error.kind}>
        <p className="muted" data-part="kind">
          {build && build.revision > 0 ? (
            <>
              Build after <span className="num">r{build.revision}</span> failed
            </>
          ) : (
            'First build failed'
          )}
          {' · '}
          {kindWords(error.kind)}
        </p>
        <p data-part="told">{toldLine(told)}</p>
        {problem !== null && <p role="alert">{problem}</p>}
      </div>
      <div className="sheet-body" ref={body}>
        <p className="sheet-message">{error.message}</p>
        {error.diagnosis && (
          <>
            <h3 className="section-title">Why</h3>
            <pre className="sheet-pre" data-part="diagnosis">{diagnosisText(error.diagnosis).slice(WHY.length)}</pre>
          </>
        )}
        {error.traceback?.trim() && (
          <>
            <h3 className="section-title">Traceback</h3>
            <pre className="sheet-pre" data-part="traceback">{error.traceback.trimEnd()}</pre>
          </>
        )}
        {error.output?.trim() && (
          <>
            <h3 className="section-title">Output</h3>
            <pre className="sheet-pre" data-part="output">{error.output.trimEnd()}</pre>
          </>
        )}
      </div>
    </section>
  )
}

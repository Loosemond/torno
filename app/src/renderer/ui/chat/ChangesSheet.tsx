import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MAX_FILE_BYTES, type FileChange, type TurnChanges } from '../../../shared/changes'
import { pressed } from '../../../shared/keys'
import { numbered } from '../numbered'
import { Diff } from './Diff'
import { diffText } from './lineDiff'

type Loaded = { state: 'loading' } | { state: 'kept'; changes: TurnChanges } | { state: 'not-kept' }

/** What main has of a turn's changes, asked once when the sheet opens. A refusal or a failure is "not kept". */
function useChanges(sessionId: string | undefined, turnId: string): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  useEffect(() => {
    let live = true
    if (!sessionId) {
      setLoaded({ state: 'not-kept' })
      return
    }
    void window.torno.chat.changes(sessionId, turnId).then(
      (changes) => live && setLoaded(changes ? { state: 'kept', changes } : { state: 'not-kept' }),
      () => live && setLoaded({ state: 'not-kept' })
    )
    return () => {
      live = false
    }
  }, [sessionId, turnId])
  return loaded
}

/** What happened to a file in the turn, in a word. */
export const fileWord = (f: FileChange): string => (f.tooLarge ? 'changed' : f.before === null ? 'new' : f.after === null ? 'removed' : 'changed')

/** The file as it is now, read only, in the monospace face. Nothing of it is run, searched for refs or written. */
function WholeFile({ file }: { file: FileChange }) {
  if (file.tooLarge) return <p className="changes-note">{numbered(`Too large to show: torno keeps files of up to ${Math.round(MAX_FILE_BYTES / 1000)} KB.`)}</p>
  if (file.after === null) return <p className="changes-note">The file was removed in this turn.</p>
  return <pre className="chat-pre changes-whole selectable">{file.after}</pre>
}

function FileView({ file }: { file: FileChange }) {
  const [whole, setWhole] = useState(false)
  const hunks = useMemo(() => (file.tooLarge ? [] : [diffText(file.before ?? '', file.after ?? '')]), [file])
  return (
    <div className="changes-file">
      <div className="changes-modes" role="group" aria-label={`${file.file}: how to show it`}>
        <button type="button" className="button button-quiet" aria-pressed={!whole} onClick={() => setWhole(false)}>
          Changes
        </button>
        <button type="button" className="button button-quiet" aria-pressed={whole} onClick={() => setWhole(true)}>
          Whole file
        </button>
      </div>
      {whole ? (
        <WholeFile file={file} />
      ) : file.tooLarge ? (
        <p className="changes-note">{numbered(`Too large to compare: torno keeps files of up to ${Math.round(MAX_FILE_BYTES / 1000)} KB.`)}</p>
      ) : (
        <Diff hunks={hunks} ofEdit={false} />
      )}
    </div>
  )
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * The model's source as a turn changed it, over the transcript as a picture is shown large: for each `.py` file of the
 * project's folder that differs, the file at the start of the turn against its end, as a diff, and the file as it is now,
 * read only. Below, the numbers of the turn's builds taken together (`net`, from the kernel). Not a modeller: nothing
 * here edits or runs the file. What it shows is held by main in memory (`chat.changes`), for the last turns only.
 */
export function ChangesSheet({ sessionId, turnId, net, host, onClose }: { sessionId: string | undefined; turnId: string; net: string[]; host: Element; onClose: () => void }) {
  const loaded = useChanges(sessionId, turnId)
  const layer = useRef<HTMLDivElement>(null)
  const [chosen, setChosen] = useState(0)
  useEffect(() => {
    layer.current?.focus()
  }, [])
  const files = loaded.state === 'kept' ? loaded.changes.files : []
  const file = files[Math.min(chosen, files.length - 1)]

  return createPortal(
    <div
      ref={layer}
      className="changes-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Changes in this turn"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (pressed(e, 'chat.close')) {
          e.stopPropagation()
          onClose()
          return
        }
        // Tab goes round within the sheet.
        if (!pressed(e, 'sheet.round')) return
        const items = [...(layer.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
        if (items.length === 0) return e.preventDefault()
        const at = items.indexOf(document.activeElement as HTMLElement)
        const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1
        e.preventDefault()
        items[next].focus()
      }}
    >
      <div className="changes-head">
        <h3 className="changes-title">Changes in this turn</h3>
        <button type="button" className="button button-quiet" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="changes-body">
        {loaded.state === 'loading' && <p className="changes-note">Reading…</p>}
        {loaded.state === 'not-kept' && <p className="changes-note">No change to a model file of this project is kept for this turn. torno holds the last 20 turns of a session, in memory, and only the .py files in the project's folder.</p>}
        {files.length > 1 && (
          <div className="changes-files" role="group" aria-label="Files changed">
            {files.map((f, n) => (
              <button key={f.file} type="button" className="button button-quiet" aria-pressed={file === f} onClick={() => setChosen(n)}>
                {f.file} <span className="muted">{fileWord(f)}</span>
              </button>
            ))}
          </div>
        )}
        {file && (
          <>
            {files.length === 1 && (
              <p className="changes-name">
                {file.file} <span className="muted">{fileWord(file)}</span>
              </p>
            )}
            <FileView key={file.file} file={file} />
          </>
        )}
        {net.length > 0 && (
          <div className="changes-net">
            <p className="changes-name">The builds, taken together</p>
            <ul>
              {net.map((line) => (
                <li key={line}>{numbered(line)}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>,
    host
  )
}

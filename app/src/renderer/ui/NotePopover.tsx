import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Mark } from '../../shared/marks'
import { actions, useStore } from '../state/store'
import { labelText } from '../viewport/marks/labels'
import type { Viewport } from '../viewport/Viewport'
import { MAX_NOTE } from './MarkRow'
import { placeBeside } from './notePlacement'

/** What the note may not cover: the tools at the left edge, the view bar at the top, and a margin elsewhere. */
const KEEP_CLEAR = { left: 60, top: 54, right: 12, bottom: 12 }

/** What a mark is on, in a few words of the monospace face: its ref and the kernel's line, an arrow's length, or the plane and the size of a profile. */
function subject(mark: Mark): { ref: string; detail: string } {
  if (mark.kind === 'arrow') {
    const length = Math.hypot(mark.to[0] - mark.from.point[0], mark.to[1] - mark.from.point[1], mark.to[2] - mark.from.point[2])
    return { ref: `${length.toFixed(1)} mm`, detail: mark.from.ref ? `from ${mark.from.ref}` : '' }
  }
  if (mark.kind === 'stroke' && mark.space === 'plane' && mark.plane) {
    // A profile: the plane it is on, and how large it is there.
    const us = (mark.points2d ?? []).map((p) => p[0])
    const vs = (mark.points2d ?? []).map((p) => p[1])
    const size = us.length > 0 ? `${(Math.max(...us) - Math.min(...us)).toFixed(1)} × ${(Math.max(...vs) - Math.min(...vs)).toFixed(1)} mm` : ''
    return { ref: mark.plane.label, detail: [size, mark.anchor.ref ? `from ${mark.anchor.ref}` : ''].filter(Boolean).join(', ') }
  }
  const anchor = mark.anchor
  return { ref: anchor?.ref ?? anchor?.part ?? '', detail: anchor?.descriptor ?? '' }
}

/**
 * The note of the mark just made, as a small card beside it over the
 * viewport. It appears when a tool has placed a mark and goes when the note
 * is saved or left, when the mark is deleted, and when another object or
 * layout is shown.
 */
export function NotePopover({ viewport }: { viewport: Viewport }) {
  const objectId = useStore((s) => s.objectId)
  // Not there for a moment after it is made: main tells of it in its own time.
  const mark = useStore((s) => (s.noting === null ? undefined : s.marks.find((m) => m.id === s.noting)))
  // A resolved mark is not drawn: there is nothing to put its note beside.
  if (!objectId || !mark || mark.status === 'resolved') return null
  return <NoteCard key={mark.id} viewport={viewport} objectId={objectId} mark={mark} />
}

function NoteCard({ viewport, objectId, mark }: { viewport: Viewport; objectId: string; mark: Mark }) {
  const card = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(mark.note)
  const { id } = mark

  const refused = (e: unknown): void => actions.setMarksProblem({ objectId, message: e instanceof Error ? e.message : String(e) })
  const save = (): void => {
    const note = text.trim()
    if (note !== mark.note) window.torno.marks.update(objectId, id, { note }).catch(refused)
    actions.closeNote()
  }
  // What a press outside saves: the text as it is then, not as it was when the listener was made.
  const saveRef = useRef(save)
  saveRef.current = save

  // Beside the mark, and there again after every frame: it follows the camera
  // without anything of that passing through React.
  useLayoutEffect(() => {
    const element = card.current!
    const place = (): void => {
      const pane = element.offsetParent?.getBoundingClientRect()
      const box = viewport.markBox(id)
      if (!pane || !box) {
        element.style.visibility = 'hidden'
        return
      }
      const within = { left: KEEP_CLEAR.left, top: KEEP_CLEAR.top, right: pane.width - KEEP_CLEAR.right, bottom: pane.height - KEEP_CLEAR.bottom }
      const covered = { left: box.left - pane.left, top: box.top - pane.top, right: box.right - pane.left, bottom: box.bottom - pane.top }
      const at: [number, number] = [box.at[0] - pane.left, box.at[1] - pane.top]
      const placed = placeBeside(covered, at, { w: element.offsetWidth, h: element.offsetHeight }, within)
      element.style.transform = `translate(${Math.round(placed.x)}px, ${Math.round(placed.y)}px)`
      element.dataset.side = placed.side
      element.style.visibility = ''
    }
    place()
    const offDrawn = viewport.onDrawn(place)
    // The card grows with what is written in it.
    const sized = new ResizeObserver(place)
    sized.observe(element)
    return () => {
      offDrawn()
      sized.disconnect()
    }
  }, [viewport, id])

  useEffect(() => {
    field.current?.focus({ preventScroll: true })
    // A press anywhere else is the end of writing: what was written is kept.
    const onPress = (e: PointerEvent): void => {
      if (e.target instanceof Node && card.current?.contains(e.target)) return
      saveRef.current()
    }
    document.addEventListener('pointerdown', onPress, true)
    return () => document.removeEventListener('pointerdown', onPress, true)
  }, [])

  const on = subject(mark)
  const label = labelText(mark)

  return (
    <div ref={card} className="note-card" role="group" aria-label={`Mark ${label}`} data-author={mark.author} data-mark={id} style={{ visibility: 'hidden' }}>
      <div className="note-head">
        <span className="mark-chip num" data-author={mark.author}>
          {label}
        </span>
        <span className="note-ref num">{on.ref}</span>
        <button
          type="button"
          className="icon-button"
          aria-label={`Delete mark ${id}`}
          title="Delete this mark"
          onClick={() => {
            window.torno.marks.remove(objectId, id).catch(refused)
            actions.closeNote()
          }}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.75 4.5h10.5M6.25 4.5V2.75h3.5V4.5M4.25 4.5l.6 8.75h6.3l.6-8.75M6.75 7v3.75M9.25 7v3.75" />
          </svg>
        </button>
      </div>
      {on.detail !== '' && (
        <p className="note-detail num" title={on.detail}>
          {on.detail}
        </p>
      )}
      <textarea
        ref={field}
        className="note-field"
        rows={1}
        value={text}
        maxLength={MAX_NOTE}
        placeholder="What should change here?"
        aria-label={`Note on ${id}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) save()
          else if (e.key === 'Escape') actions.closeNote()
          else return
          e.preventDefault()
          e.stopPropagation()
        }}
      />
      <p className="note-keys">
        <kbd className="num">Enter</kbd>save
        <kbd className="num">Esc</kbd>leave it for later
      </p>
    </div>
  )
}

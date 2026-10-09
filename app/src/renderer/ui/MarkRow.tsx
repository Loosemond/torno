import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Mark, MarkKind, MarkPatch } from '../../shared/marks'
import { actions, store } from '../state/store'
import { endReplace, startReplace, useReplacing } from '../state/tools'
import { labelText } from '../viewport/marks/labels'
import { ShapeFields } from './ShapeFields'
import { ICONS, SHAPE_ICONS } from './ToolPalette'

/** The longest note a mark keeps (main cuts there); the field stops at it, so nothing is cut unseen. */
export const MAX_NOTE = 2000

const KIND_ICON: Record<MarkKind, ReactNode> = { pin: ICONS.pin, pick: ICONS.select, arrow: ICONS.arrow, stroke: ICONS.draw, shape: ICONS.shape }
const KIND_NAME: Record<MarkKind, string> = { pin: 'Pin', pick: 'Pick', arrow: 'Arrow', stroke: 'Stroke', shape: 'Shape' }
const ANCHOR_NOTE = {
  ok: '',
  drifted: 'The surface it was on has moved since it was placed',
  orphaned: 'The part it was on is gone'
} as const
/** What the row says of a mark the last build left off its surface, or without its part. */
export const ANCHOR_BADGE = { drifted: 'moved: check it', orphaned: 'its part is gone' } as const
/** What the row says of a mark whose layout the build no longer has: it cannot be shown, and going to it does nothing. */
export const LAYOUT_GONE = 'its layout is gone'

/**
 * One mark in the panel: its number, what kind it is, its note (click to
 * write it), whether the last build moved the surface it is on or dropped its
 * part, whether the agent has been sent it, and what can be done with it. A
 * shape that is the active mark opens out below into its numbers
 * (`ShapeFields`). `change` and `remove` are the panel's, which says so when
 * main refuses.
 */
export function MarkRow({
  mark,
  active,
  elsewhere,
  gone = false,
  change,
  remove
}: {
  mark: Mark
  active: boolean
  /** The mark is of a layout that is not the one shown. */
  elsewhere: boolean
  /** The mark is of a layout the build no longer has. */
  gone?: boolean
  /** Resolves when main has made the change; rejects when it refuses. */
  change: (patch: MarkPatch) => Promise<unknown>
  remove: () => void
}) {
  // The note as it is being written; null while it is only shown.
  const [draft, setDraft] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  const resolved = mark.status === 'resolved'
  const label = labelText(mark)
  const replacing = useReplacing() === mark.id
  // Offered where it can be done: a pin, a pick or an arrow that the last build left off its surface or without
  // its part, in the layout shown, where the next click on a part ties it again.
  const replaceable = !resolved && !elsewhere && mark.anchorState !== 'ok' && (mark.kind === 'pin' || mark.kind === 'pick' || mark.kind === 'arrow')

  const writing = draft !== null
  useEffect(() => {
    if (writing) field.current?.select()
  }, [writing])

  const save = () => {
    if (draft === null) return
    if (draft !== mark.note) void change({ note: draft }).catch(() => {})
    setDraft(null)
  }
  // A shape is edited where it can be seen: in its own layout, while it is the one being worked on.
  const fields = mark.kind === 'shape' && active && !resolved && !elsewhere

  const what = [KIND_NAME[mark.kind], mark.kind === 'shape' ? `${mark.shape}, ${mark.intent}` : '', elsewhere ? `in layout ${mark.layout}` : ''].filter(Boolean).join(' · ')

  return (
    <li
      className="mark-row"
      data-mark={mark.id}
      data-author={mark.author}
      data-status={mark.status}
      data-active={active ? '' : undefined}
      data-elsewhere={elsewhere ? '' : undefined}
      data-expanded={fields ? '' : undefined}
      data-replacing={replacing ? '' : undefined}
      aria-current={active ? 'true' : undefined}
      onClick={() => actions.focusMark(mark.id)}
    >
      <span className="mark-chip num" data-author={mark.author} title={[mark.author === 'user' ? 'Your mark' : "The agent's mark", ANCHOR_NOTE[mark.anchorState]].filter(Boolean).join('. ')}>
        {label}
      </span>
      <span className="mark-kind" title={what} aria-label={what} role="img">
        {mark.kind === 'shape' ? SHAPE_ICONS[mark.shape] : KIND_ICON[mark.kind]}
      </span>
      {draft === null ? (
        <button
          type="button"
          className="mark-note"
          data-empty={mark.note === '' ? '' : undefined}
          title={[mark.note, mark.resolvedNote ? `Resolved: ${mark.resolvedNote}` : ''].filter(Boolean).join('\n') || 'Write a note'}
          aria-label={`Note of ${mark.id}: ${mark.note || 'none'}. Edit`}
          onClick={(e) => {
            // Writing a note is not asking to go anywhere: the camera stays.
            e.stopPropagation()
            actions.setActiveMark(mark.id)
            setDraft(mark.note)
          }}
        >
          {mark.note || 'Add a note'}
        </button>
      ) : (
        <input
          ref={field}
          className="mark-note-input"
          value={draft}
          maxLength={MAX_NOTE}
          aria-label={`Note of ${mark.id}`}
          autoFocus
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            else if (e.key === 'Escape') setDraft(null)
            else return
            e.preventDefault()
            e.stopPropagation()
          }}
        />
      )}
      {!resolved && gone ? (
        <span className="mark-anchor" data-state="orphaned" title={`The build no longer has the layout ${mark.layout}, so this mark cannot be shown`}>
          {LAYOUT_GONE}
        </span>
      ) : (
        !resolved &&
        mark.anchorState !== 'ok' && (
          <span className="mark-anchor" data-state={mark.anchorState} title={ANCHOR_NOTE[mark.anchorState]}>
            {ANCHOR_BADGE[mark.anchorState]}
          </span>
        )
      )}
      {elsewhere && <span className="mark-layout num">{mark.layout}</span>}
      {!resolved && (
        <span className="mark-status" data-status={mark.status}>
          {mark.status}
        </span>
      )}
      <span className="mark-actions" onClick={(e) => e.stopPropagation()}>
        {replaceable && (
          <button
            type="button"
            className="icon-button"
            aria-label={`Re-place ${mark.id}`}
            aria-pressed={replacing}
            title={replacing ? 'Click the part where it should be. Esc leaves it where it is' : 'Re-place: put it somewhere else on the part with a click'}
            onClick={() => {
              const objectId = store.getState().objectId
              if (replacing) endReplace()
              else if (objectId) {
                actions.setActiveMark(mark.id)
                startReplace(objectId, mark.id)
              }
            }}
          >
            <ReplaceIcon />
          </button>
        )}
        <button type="button" className="icon-button" aria-label={`Go to ${mark.id}`} title={gone ? LAYOUT_GONE : 'Go to its view'} disabled={gone} onClick={() => actions.focusMark(mark.id)}>
          <FocusIcon />
        </button>
        {resolved ? (
          <button type="button" className="icon-button" aria-label={`Reopen ${mark.id}`} title="Reopen as a draft" onClick={() => void change({ status: 'draft' }).catch(() => {})}>
            <ReopenIcon />
          </button>
        ) : (
          <button type="button" className="icon-button" aria-label={`Resolve ${mark.id}`} title="Resolve" onClick={() => void change({ status: 'resolved' }).catch(() => {})}>
            <CheckIcon />
          </button>
        )}
        <button type="button" className="icon-button" aria-label={`Delete ${mark.id}`} title="Delete" onClick={remove}>
          <BinIcon />
        </button>
      </span>
      {fields && <ShapeFields mark={mark} change={change} />}
    </li>
  )
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

/** A pin, and under it an arrow both ways: put it somewhere else. */
function ReplaceIcon() {
  return (
    <Glyph>
      <circle cx="8" cy="4.5" r="2.5" />
      <path d="M8 7v3M2.75 12.75h10.5M4.5 11 2.75 12.75 4.5 14.5M11.5 11l1.75 1.75-1.75 1.75" />
    </Glyph>
  )
}

/** A reticle: go and look. */
function FocusIcon() {
  return (
    <Glyph>
      <circle cx="8" cy="8" r="3.25" />
      <path d="M8 1.75v2.5M8 11.75v2.5M1.75 8h2.5M11.75 8h2.5" />
    </Glyph>
  )
}

function CheckIcon() {
  return (
    <Glyph>
      <path d="m3 8.5 3.25 3.25L13 4.75" />
    </Glyph>
  )
}

/** An arrow turning back. */
function ReopenIcon() {
  return (
    <Glyph>
      <path d="M3.25 6.5h6a3.25 3.25 0 0 1 0 6.5H6.5M5.75 3.75 3 6.5l2.75 2.75" />
    </Glyph>
  )
}

function BinIcon() {
  return (
    <Glyph>
      <path d="M2.75 4.5h10.5M6.25 4.5V2.75h3.5V4.5M4.25 4.5l.6 8.75h6.3l.6-8.75M6.75 7v3.75M9.25 7v3.75" />
    </Glyph>
  )
}

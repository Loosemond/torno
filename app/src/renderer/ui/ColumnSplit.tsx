import { useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { which } from '../../shared/keys'
import { MARKS_FLOOR } from '../state/column'
import { actions, store, useStore } from '../state/store'
import { giveKeysBack } from './typing'

const KEY_STEP = 16

/**
 * How tall the marks may be made: as tall as they are, and all the sections above them can give, each down to its
 * least (its title). A section that does not give way (`flex-shrink: 0`: one folded, the switcher) gives nothing.
 */
function tallest(marks: HTMLElement): number {
  let room = marks.getBoundingClientRect().height
  for (let el = marks.previousElementSibling; el; el = el.previousElementSibling) {
    if (!(el instanceof HTMLElement) || !el.classList.contains('section')) continue
    const style = getComputedStyle(el)
    if (style.flexShrink === '0') continue
    room += Math.max(0, el.getBoundingClientRect().height - (parseFloat(style.minHeight) || 0))
  }
  return Math.max(MARKS_FLOOR, Math.floor(room))
}

const clamp = (height: number, marks: HTMLElement): number => Math.round(Math.min(Math.max(height, MARKS_FLOOR), tallest(marks)))

/**
 * The line above the marks (`role="separator"`): dragged up, or Up with the focus on it, the marks are taller and the
 * sections above give way, each down to its title; down, shorter, to the floor of five rows. A double click puts
 * back the shares. While it is dragged the height goes straight to `--marks-h` on the column, so nothing goes
 * through React per move; the store, and the window's storage with it, has it once the line is let go.
 */
export function ColumnSplit() {
  const objectId = useStore((s) => s.objectId)
  const height = useStore((s) => s.column.marks)
  const line = useRef<HTMLDivElement>(null)
  const drag = useRef<{ startY: number; startHeight: number; height: number } | null>(null)

  // The column has the height kept, from the start and after each change.
  useLayoutEffect(() => {
    const column = line.current?.parentElement
    if (!column) return
    if (height === null) column.style.removeProperty('--marks-h')
    else column.style.setProperty('--marks-h', `${height}px`)
  }, [height, objectId])

  if (objectId === null) return null
  const marks = (): HTMLElement | null => line.current?.nextElementSibling as HTMLElement | null

  function onDown(e: PointerEvent<HTMLDivElement>) {
    const below = marks()
    if (e.button !== 0 || !below) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const startHeight = below.getBoundingClientRect().height
    drag.current = { startY: e.clientY, startHeight, height: startHeight }
    e.currentTarget.parentElement!.toggleAttribute('data-resizing', true)
  }

  function onMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current
    const below = marks()
    if (!d || !below) return
    d.height = clamp(d.startHeight + d.startY - e.clientY, below)
    e.currentTarget.parentElement!.style.setProperty('--marks-h', `${d.height}px`)
  }

  function onUp(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    drag.current = null
    e.currentTarget.parentElement!.toggleAttribute('data-resizing', false)
    // A press that moved nothing (the first of a double click) keeps what there was.
    if (d.height !== d.startHeight) actions.setMarksHeight(d.height)
    // Dragged with the pointer, the line is done with: the next letter is the view's.
    giveKeysBack(e.currentTarget)
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const way = which(e, 'column.resize')
    const below = marks()
    if (way < 0 || !below) return
    e.preventDefault()
    const now = store.getState().column.marks ?? below.getBoundingClientRect().height
    actions.setMarksHeight(clamp(now + (way === 0 ? KEY_STEP : -KEY_STEP), below))
  }

  return (
    <div
      ref={line}
      className="column-split"
      role="separator"
      aria-label="Resize marks"
      aria-orientation="horizontal"
      aria-valuenow={height ?? undefined}
      aria-valuemin={MARKS_FLOOR}
      tabIndex={0}
      title="Drag for more room for the marks; a double click puts the shares back"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
      onDoubleClick={(e) => {
        e.currentTarget.parentElement!.style.removeProperty('--marks-h')
        actions.setMarksHeight(null)
      }}
    />
  )
}

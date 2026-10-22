import { useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { which } from '../../shared/keys'
import { MARKS_FLOOR } from '../state/column'
import { actions, store, useStore } from '../state/store'
import { giveKeysBack } from './typing'

const KEY_STEP = 16

/**
 * How tall the marks may be made: the column, less everything else in it, each section that gives way (`flex-shrink`
 * not 0) at its least (its title) and the rest (the head, the switcher, a folded section, a note) as they are. Read
 * from the column as it is laid out now, whatever the marks hold: a shorter window, or a section that came above
 * them (Parameters, a problem with the folder), leaves less.
 */
function tallest(marks: HTMLElement): number {
  const column = marks.parentElement
  if (!column) return MARKS_FLOOR
  const outer = getComputedStyle(column)
  let room = column.clientHeight - (parseFloat(outer.paddingTop) || 0) - (parseFloat(outer.paddingBottom) || 0)
  for (const el of column.children) {
    if (el === marks || !(el instanceof HTMLElement)) continue
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.position === 'absolute' || style.position === 'fixed') continue
    const margins = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0)
    const gives = el.classList.contains('section') && style.flexShrink !== '0'
    room -= (gives ? parseFloat(style.minHeight) || 0 : el.getBoundingClientRect().height) + margins
  }
  return Math.max(MARKS_FLOOR, Math.floor(room))
}

const clamp = (height: number, marks: HTMLElement): number => Math.round(Math.min(Math.max(height, MARKS_FLOOR), tallest(marks)))

/**
 * The line above the marks (`role="separator"`): dragged up, or Up with the focus on it, the marks are taller and the
 * sections above give way, each down to its title; down, shorter, to the floor of five rows. A double click puts
 * back the shares. While it is dragged the height goes straight to `--marks-h` on the column, so nothing goes
 * through React per move; the store, and the window's storage with it, has it once the line is let go. The column
 * has what is kept as far as there is room for it now: as the column or what is above the marks changes, `--marks-h`
 * is the height kept cut to the room (`tallest`), which is what `aria-valuenow` says, and what is kept is not touched.
 */
export function ColumnSplit() {
  const objectId = useStore((s) => s.objectId)
  const height = useStore((s) => s.column.marks)
  const line = useRef<HTMLDivElement>(null)
  const drag = useRef<{ startY: number; startHeight: number; height: number } | null>(null)

  // The column has the height kept as far as there is room, from the start, after each change and whenever the room
  // does: the column is resized, or a section above it is (or comes, or goes).
  useLayoutEffect(() => {
    const split = line.current
    const column = split?.parentElement
    if (!split || !column) return
    if (height === null) {
      column.style.removeProperty('--marks-h')
      split.removeAttribute('aria-valuenow')
      return
    }
    const fit = (): void => {
      const below = split.nextElementSibling
      if (drag.current || !(below instanceof HTMLElement)) return
      const shown = `${clamp(height, below)}`
      if (column.style.getPropertyValue('--marks-h') !== `${shown}px`) column.style.setProperty('--marks-h', `${shown}px`)
      if (split.getAttribute('aria-valuenow') !== shown) split.setAttribute('aria-valuenow', shown)
    }
    const sized = new ResizeObserver(fit)
    const watch = (): void => {
      sized.disconnect()
      sized.observe(column)
      for (const el of column.children) if (el !== split.nextElementSibling) sized.observe(el)
    }
    const changed = new MutationObserver(() => {
      watch()
      fit()
    })
    changed.observe(column, { childList: true })
    watch()
    fit()
    return () => {
      sized.disconnect()
      changed.disconnect()
    }
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
    // From the height shown: one kept taller than there is room for now is cut to it first.
    const kept = store.getState().column.marks
    const now = kept === null ? below.getBoundingClientRect().height : clamp(kept, below)
    actions.setMarksHeight(clamp(now + (way === 0 ? KEY_STEP : -KEY_STEP), below))
  }

  return (
    <div
      ref={line}
      className="column-split"
      role="separator"
      aria-label="Resize marks"
      aria-orientation="horizontal"
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

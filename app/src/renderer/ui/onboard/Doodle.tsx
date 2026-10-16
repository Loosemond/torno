import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { hint, pressed } from '../../../shared/keys'
import type { Stroke } from '../../state/onboard'
import { Confirm } from '../Confirm'
import { BOARD, ERASER_WIDTH, PEN_WIDTHS, addPoint, doodlePng, paintStroke, paintStrokes } from './strokes'

type Tool = 'thin' | 'thick' | 'eraser'

const TOOLS: ReadonlyArray<{ id: Tool; label: string }> = [
  { id: 'thin', label: 'Thin pen' },
  { id: 'thick', label: 'Thick pen' },
  { id: 'eraser', label: 'Eraser' }
]

/** What can take the focus in the board, in order. */
const FOCUSABLE = 'button:not(:disabled), [tabindex="0"]'

/** The ink as the theme has it now: the board's strokes are drawn in it, and the PNG is made in its own. */
const inkNow = (): string => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#22252A'

/**
 * The doodle board: a sheet over the page with a canvas of 1200 x 800 board pixels, scaled to fit. The pen has two
 * widths, the eraser takes away what is under it; undo takes the last stroke back, clear all of them. The strokes
 * are kept as vectors (`initial` is what a doodle is opened with again), and "Done" gives them back with the PNG
 * made from them. A stroke is drawn as the pointer moves, in the canvas and never through React.
 */
export function Doodle({ initial, onDone, onCancel }: { initial: Stroke[]; onDone: (strokes: Stroke[], png: Uint8Array) => void; onCancel: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const sheet = useRef<HTMLElement>(null)
  const strokes = useRef<Stroke[]>(initial.map((s) => ({ ...s, points: [...s.points] })))
  const drawing = useRef<{ stroke: Stroke; pointer: number; painted: number } | null>(null)
  const tool = useRef<Tool>('thin')
  const [chosen, setChosen] = useState<Tool>('thin')
  // How many strokes there are: counted up when one ends, so that the buttons know, not on every pointer move.
  const [count, setCount] = useState(strokes.current.length)
  const [saving, setSaving] = useState(false)
  const saved = useRef(false)
  /** Whether the strokes are other than the doodle was opened with: leaving then asks first. */
  const dirty = useRef(false)
  const [asking, setAsking] = useState(false)
  const askingNow = useRef(false)
  askingNow.current = asking

  const repaint = (): void => {
    const ctx = canvas.current?.getContext('2d')
    if (ctx) paintStrokes(ctx, strokes.current, inkNow())
  }

  useEffect(() => {
    repaint()
    // The ink follows the theme.
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    scheme.addEventListener('change', repaint)
    return () => scheme.removeEventListener('change', repaint)
  }, [])

  const undo = (): void => {
    if (drawing.current || strokes.current.length === 0) return
    strokes.current.pop()
    dirty.current = true
    setCount(strokes.current.length)
    repaint()
  }
  const clear = (): void => {
    if (drawing.current || strokes.current.length === 0) return
    strokes.current = []
    dirty.current = true
    setCount(0)
    repaint()
  }
  const done = async (): Promise<void> => {
    if (saved.current) return
    saved.current = true
    setSaving(true)
    const kept = strokes.current
    try {
      onDone(kept, await doodlePng(kept))
    } catch {
      saved.current = false
      setSaving(false)
    }
  }

  // The keys are the board's while it is up, wherever the focus is (a click on the canvas may leave it nowhere).
  /** Esc and Cancel: a board with something drawn on it that was not kept asks first. */
  const leave = (): void => {
    if (saved.current) return
    if (dirty.current && strokes.current.length > 0) setAsking(true)
    else onCancel()
  }
  const act = useRef({ undo, leave })
  act.current = { undo, leave }
  useEffect(() => {
    const before = document.activeElement
    sheet.current?.focus()
    // Before anything else hears of the key, so that no tool of the view under the board gets Ctrl+Z. A question
    // asked in the board has its own keys.
    const onKey = (e: KeyboardEvent): void => {
      if (askingNow.current) return
      if (pressed(e, 'sheet.close')) {
        e.preventDefault()
        e.stopPropagation()
        act.current.leave()
      } else if (pressed(e, 'board.undo')) {
        e.preventDefault()
        e.stopPropagation()
        act.current.undo()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      const now = document.activeElement
      if (before instanceof HTMLElement && before.isConnected && (now === null || now === document.body || !now.isConnected)) before.focus()
    }
  }, [])

  /** Where the pointer is on the board, in board pixels. */
  const at = (e: ReactPointerEvent<HTMLCanvasElement>): [number, number] => {
    const box = e.currentTarget.getBoundingClientRect()
    return [((e.clientX - box.left) * BOARD.width) / box.width, ((e.clientY - box.top) * BOARD.height) / box.height]
  }
  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0 || drawing.current || saving) return
    e.currentTarget.setPointerCapture(e.pointerId)
    // The keys stay with the board.
    sheet.current?.focus({ preventScroll: true })
    const [x, y] = at(e)
    const width = tool.current === 'eraser' ? ERASER_WIDTH : PEN_WIDTHS[tool.current]
    const stroke: Stroke = { tool: tool.current === 'eraser' ? 'eraser' : 'pen', width, points: [[Math.round(x * 10) / 10, Math.round(y * 10) / 10]] }
    drawing.current = { stroke, pointer: e.pointerId, painted: 0 }
    const ctx = e.currentTarget.getContext('2d')!
    paintStroke(ctx, stroke, inkNow())
    drawing.current.painted = 1
  }
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const d = drawing.current
    if (!d || d.pointer !== e.pointerId) return
    const ctx = e.currentTarget.getContext('2d')!
    // The moves the browser folded into this one are in the coalesced events: a quick line stays smooth.
    for (const one of e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]) {
      const box = e.currentTarget.getBoundingClientRect()
      addPoint(d.stroke, ((one.clientX - box.left) * BOARD.width) / box.width, ((one.clientY - box.top) * BOARD.height) / box.height)
    }
    if (d.stroke.points.length > d.painted) {
      paintStroke(ctx, d.stroke, inkNow(), d.painted)
      d.painted = d.stroke.points.length
    }
  }
  const onUp = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const d = drawing.current
    if (!d || d.pointer !== e.pointerId) return
    drawing.current = null
    strokes.current.push(d.stroke)
    dirty.current = true
    setCount(strokes.current.length)
  }

  return (
    <div className="board-layer">
      <section
        ref={sheet}
        className="board-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Doodle board"
        tabIndex={-1}
        onKeyDown={(e) => {
          // No key of the page under it is handed on.
          e.stopPropagation()
          if (!pressed(e, 'sheet.round')) return
          const stops = [...sheet.current!.querySelectorAll<HTMLElement>(FOCUSABLE)]
          if (stops.length === 0) return e.preventDefault()
          const place = stops.indexOf(document.activeElement as HTMLElement)
          if (e.shiftKey ? place <= 0 : place === stops.length - 1) {
            e.preventDefault()
            stops[e.shiftKey ? stops.length - 1 : 0].focus()
          }
        }}
      >
        <header className="board-head">
          <h2>Doodle</h2>
          <p className="board-hint">Draw what you mean: a shape, where it goes, a size. Claude sees it as a picture.</p>
        </header>
        <div className="board-tools" role="toolbar" aria-label="Drawing tools">
          <span className="view-switch" role="group" aria-label="Tool">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                className="button button-quiet"
                aria-pressed={chosen === t.id}
                onClick={() => {
                  tool.current = t.id
                  setChosen(t.id)
                }}
              >
                {t.label}
              </button>
            ))}
          </span>
          <span className="spacer" />
          <button type="button" className="button button-quiet" disabled={count === 0 || saving} title={`Take the last stroke back (${hint('board.undo')})`} onClick={undo}>
            Undo
          </button>
          <button type="button" className="button button-quiet" disabled={count === 0 || saving} onClick={clear}>
            Clear
          </button>
        </div>
        <div className="board-stage">
          <canvas
            ref={canvas}
            className="board-canvas"
            width={BOARD.width}
            height={BOARD.height}
            aria-label="Drawing area"
            data-strokes={count}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          />
        </div>
        {asking && (
          <Confirm label="Discard this doodle?" accept="Discard" cancel="Keep drawing" onCancel={() => setAsking(false)} onAccept={onCancel}>
            Discard this doodle? What was drawn since it was opened is not kept.
          </Confirm>
        )}
        <footer className="board-foot">
          <p className="board-size num">
            {BOARD.width} × {BOARD.height}
          </p>
          <button type="button" className="button" disabled={saving} title={`Put the board away without keeping this (${hint('sheet.close')})`} onClick={leave}>
            Cancel
          </button>
          <button type="button" className="button button-primary" disabled={saving || count === 0} onClick={() => void done()}>
            Done
          </button>
        </footer>
      </section>
    </div>
  )
}

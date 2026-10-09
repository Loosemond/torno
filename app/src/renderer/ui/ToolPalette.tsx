import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ShapeKind } from '../../shared/marks'
import { BETWEEN, ROUND, SHAPES, TOOLS, setBetween, setRound, setShape, setTool, useBetween, useRound, useShape, useTool, type ToolName } from '../state/tools'
import { TYPING } from './typing'

/**
 * The tools, floating at the left edge of the viewport: what the pointer does
 * there. Each has a key, shown on its button, which works wherever the view
 * keys do. The Shape button also opens the choice of which shape to place;
 * the one chosen last is the one it shows, and the one its key takes.
 */
export function ToolPalette() {
  const tool = useTool()
  const shape = useShape()
  const [choosing, setChoosing] = useState(false)
  const choice = useRef<HTMLDivElement>(null)

  // The choice is open only while the Shape tool is in hand, and closes on a press elsewhere or Escape.
  useEffect(() => {
    if (tool !== 'shape') setChoosing(false)
  }, [tool])
  useEffect(() => {
    if (!choosing) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key !== 'Escape' : choice.current?.contains(e.target as Node)) return
      setChoosing(false)
      // Escape closed the choice, and that is all it did: the tool stays in hand.
      if (e instanceof KeyboardEvent) e.preventDefault()
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', close, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', close, true)
    }
  }, [choosing])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      if (e.target instanceof Element && e.target.closest(TYPING)) return
      const wanted = TOOLS.find((t) => t.key === e.key.toUpperCase())
      if (!wanted?.ready) return
      setTool(wanted.name)
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
    {tool === 'measure' && <MeasureChoice />}
    <div className="toolbox" role="toolbar" aria-label="Tools" aria-orientation="vertical">
      {TOOLS.map((t) =>
        t.name === 'shape' ? (
          <div key={t.name} className="tool-with-choice" ref={choice}>
            <button
              type="button"
              className="tool-button"
              data-tool={t.name}
              data-shape={shape}
              aria-label={t.label}
              aria-pressed={t.name === tool}
              aria-keyshortcuts={t.key}
              aria-haspopup="menu"
              aria-expanded={choosing}
              title={`${t.label} (${t.key}): ${shape}. Click to choose another`}
              onClick={() => {
                setTool(t.name)
                setChoosing((open) => !open)
              }}
            >
              {SHAPE_ICONS[shape]}
              <span className="tool-key num" aria-hidden="true">
                {t.key}
              </span>
            </button>
            {choosing && (
              <div className="tool-choice" role="menu" aria-label="Shape to place">
                {SHAPES.map((s) => (
                  <button
                    key={s.kind}
                    type="button"
                    role="menuitemradio"
                    className="tool-button"
                    aria-checked={s.kind === shape}
                    aria-label={s.label}
                    title={s.label}
                    onClick={() => {
                      setShape(s.kind)
                      setChoosing(false)
                    }}
                  >
                    {SHAPE_ICONS[s.kind]}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button
            key={t.name}
            type="button"
            className="tool-button"
            data-tool={t.name}
            aria-label={t.label}
            aria-pressed={t.name === tool}
            aria-keyshortcuts={t.key}
            title={t.ready ? `${t.label} (${t.key})` : `${t.label} (${t.key}): not available yet`}
            disabled={!t.ready}
            onClick={() => setTool(t.name)}
          >
            {ICONS[t.name]}
            <span className="tool-key num" aria-hidden="true">
              {t.key}
            </span>
          </button>
        )
      )}
    </div>
    </>
  )
}

/**
 * In the bottom corner of the viewport while the Measure tool is in hand,
 * clear of the part: what two clicks measure, what a double click on something round
 * measures, and the key that has no button. Each choice holds for the pair
 * of clicks under way, and from then on.
 */
function MeasureChoice() {
  const between = useBetween()
  const round = useRound()
  return (
    <div className="measure-choice" role="group" aria-label="What to measure">
      <div className="segmented" role="group" aria-label="Two clicks measure">
        {BETWEEN.map((b) => (
          <button key={b.measure} type="button" title={b.title} aria-pressed={b.measure === between} onClick={() => setBetween(b.measure)}>
            {b.label}
          </button>
        ))}
      </div>
      <div className="segmented" role="group" aria-label="A double click on something round measures">
        {ROUND.map((r) => (
          <button key={r.measure} type="button" title={r.title} aria-pressed={r.measure === round} onClick={() => setRound(r.measure)}>
            {r.label}
          </button>
        ))}
      </div>
      <span className="measure-key" title="Press T with the pointer on a face to measure the wall under it. Shift-click measures from a bare point">
        <kbd className="num">T</kbd> thickness
      </span>
    </div>
  )
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

/** The picture of each shape the Shape tool places: on its button, in its choice, and on the shape's row in the marks panel. */
export const SHAPE_ICONS: Record<ShapeKind, ReactNode> = {
  // A box, seen from a corner.
  box: (
    <Icon>
      <path d="M8 1.750 13.500 4.750v6.500L8 14.250l-5.500-3v-6.500L8 1.750ZM2.500 4.750 8 7.750l5.500-3M8 7.750v6.500" />
    </Icon>
  ),
  // A cylinder, standing.
  cylinder: (
    <Icon>
      <ellipse cx="8" cy="4.250" rx="4.750" ry="2" />
      <path d="M3.250 4.250v7.500c0 1.100 2.130 2 4.750 2s4.750-.9 4.750-2v-7.500" />
    </Icon>
  ),
  // A sphere, with its equator.
  sphere: (
    <Icon>
      <circle cx="8" cy="8" r="5.750" />
      <path d="M2.250 8c0 1.100 2.570 2 5.750 2s5.750-.9 5.750-2" />
    </Icon>
  ),
  // A plane, lying flat.
  plane: (
    <Icon>
      <path d="M5 4.750h9.250L11 11.250H1.750L5 4.750Z" />
    </Icon>
  )
}

/** The picture of each tool; the marks panel shows the same ones for what the tools leave. */
export const ICONS: Record<ToolName, ReactNode> = {
  // A pointer.
  select: (
    <Icon>
      <path d="M3.5 2.5v10l2.9-2.6 1.9 4 1.6-.8-1.9-3.9 3.7-.3-8.2-6.4Z" />
    </Icon>
  ),
  // A map pin, standing on its point.
  pin: (
    <Icon>
      <path d="M8 14s4-4.2 4-7.4a4 4 0 0 0-8 0C4 9.800 8 14 8 14Z" />
      <circle cx="8" cy="6.5" r="1.4" />
    </Icon>
  ),
  // From a point, to where it should go.
  arrow: (
    <Icon>
      <path d="M3 13 12.5 3.500M7.500 3.250h5.250V8.500" />
    </Icon>
  ),
  // A pencil.
  draw: (
    <Icon>
      <path d="m2.750 13.250.7-3L10.900 2.800a1.100 1.100 0 0 1 1.550 0l.75.750a1.100 1.100 0 0 1 0 1.550L5.750 12.550l-3 .7ZM9.750 4l2.250 2.250" />
    </Icon>
  ),
  shape: SHAPE_ICONS.box,
  // A block sawn through: the half that is kept, the half that is taken away, and the plane between them.
  section: (
    <Icon>
      <path d="M3.750 8v4.750h8.500V8M1.500 8h13" />
      <path d="M3.750 6V3.250h8.500V6" strokeDasharray="1.5 2" />
    </Icon>
  ),
  // A rule, laid across: its edge and its graduations.
  measure: (
    <Icon>
      <path d="M1.750 10.250 10.250 1.750l4 4-8.500 8.500-4-4ZM4.500 7.500l1.500 1.500M6.750 5.250l1 1M9 3l1.500 1.500" />
    </Icon>
  ),
}

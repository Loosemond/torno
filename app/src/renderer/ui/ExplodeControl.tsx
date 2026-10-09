import { useEffect, useRef, useState } from 'react'
import { useStore as useZustand } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { type ExplodeState, NO_EXPLODE, SECTION_FIRST } from '../../shared/explode'
import { number } from '../../shared/format'
import { actions, explodeNow, partsInLayout, store, useStore, type TornoState } from '../state/store'
import type { Viewport } from '../viewport/Viewport'

/** Said of a layout with nothing to draw apart. */
export const ONE_PART = 'One part: nothing to draw apart'
/** How far apart `E` draws the parts of a layout that has not been drawn apart before. */
const FIRST_AMOUNT = 0.5
/** How long what `E` could not do stays said under the bar. */
const SAID_FOR_MS = 4000

const AXES: Array<{ axis: ExplodeState['axis']; label: string; title: string }> = [
  { axis: 'centre', label: 'From centre', title: 'Each part away from the middle of the layout' },
  { axis: 'x', label: 'X', title: 'Set the parts apart along X, in the order they lie along it' },
  { axis: 'y', label: 'Y', title: 'Set the parts apart along Y, in the order they lie along it' },
  { axis: 'z', label: 'Z', title: 'Set the parts apart along Z, in the order they lie along it' }
]
const SCALES = [0.5, 1, 2, 4]

/** The last amount above 0 each layout of each object was drawn apart by, in this run: what `E` goes back to. */
const lastAmounts = new Map<string, number>()
const keyOf = (s: Pick<TornoState, 'objectId' | 'layout'>): string => `${s.objectId ?? ''}\n${s.layout}`

/** Why `E` drew nothing apart, for a moment; apart from the window's own state, like what the agent points at. */
const saidStore = createStore<{ said: string | null }>(() => ({ said: null }))
let saidTimer: ReturnType<typeof setTimeout> | undefined

/** Why the parts of the layout shown cannot be drawn apart now, as a sentence, or null. */
function whyNot(s: TornoState): string | null {
  if (partsInLayout(s).length < 2) return ONE_PART
  return s.section !== null ? SECTION_FIRST : null
}

/**
 * `E`: draws the parts of the layout shown apart, by as much as they last were (half, the first time), or puts
 * them together when they are apart. Where it cannot (one part, a section), the control says why for a moment.
 */
export function toggleExplode(): void {
  const s = store.getState()
  const apart = explodeNow(s)
  const refused = apart ? null : (whyNot(s) ?? actions.setExplode({ amount: lastAmounts.get(keyOf(s)) ?? FIRST_AMOUNT }))
  if (apart) actions.setExplode({ amount: 0 })
  clearTimeout(saidTimer)
  saidStore.setState({ said: refused })
  if (refused !== null) saidTimer = setTimeout(() => saidStore.setState({ said: null }), SAID_FOR_MS)
}

/**
 * Explode, in the view bar: how far apart the parts of the layout shown are drawn, on a slider with the amount
 * beside it, and under "More" along what and how far that reaches. For display only: while the parts are apart
 * a line under the bar says so, since nothing can be marked, measured or cut meanwhile.
 *
 * The slider moves the parts in the viewport as it is dragged and the amount is kept when it is let go; the
 * number beside it follows without a render. Nothing of a drag goes through React or the store.
 */
export function ExplodeControl({ viewport }: { viewport: Viewport }) {
  const kept = useStore((s) => s.explode[s.layout]) ?? NO_EXPLODE
  const apart = useStore((s) => explodeNow(s) !== null)
  const why = useStore(whyNot)
  // A scan is never moved: beside parts drawn apart it is no longer where they are drawn.
  const scans = useStore((s) => s.scans.some((scan) => scan.meshState === 'ok' && s.scanViews[scan.id]?.visible !== false))
  const said = useZustand(saidStore, (s) => s.said)
  const [open, setOpen] = useState(false)
  const slider = useRef<HTMLInputElement>(null)
  const amount = useRef<HTMLSpanElement>(null)
  const more = useRef<HTMLDivElement>(null)
  const shown = apart ? Math.round(kept.amount * 100) : 0

  // The slider and the number are the DOM's own while they are being changed.
  useEffect(() => {
    if (slider.current) slider.current.value = String(shown)
    if (amount.current) amount.current.textContent = percent(shown)
  }, [shown])

  useEffect(() => {
    const range = slider.current
    if (!range) return
    const preview = (): void => {
      viewport.setExplode({ ...kept, amount: Number(range.value) / 100 })
      if (amount.current) amount.current.textContent = percent(Number(range.value))
    }
    const keep = (): void => {
      const refused = actions.setExplode({ amount: Number(range.value) / 100 })
      // Refused (a section came meanwhile): back to what is kept, on the slider and in the view.
      if (refused === null) return
      range.value = String(shown)
      if (amount.current) amount.current.textContent = percent(shown)
      viewport.setExplode(explodeNow(store.getState()))
    }
    range.addEventListener('input', preview)
    range.addEventListener('change', keep)
    return () => {
      range.removeEventListener('input', preview)
      range.removeEventListener('change', keep)
    }
  }, [viewport, kept, shown])

  // What `E` goes back to: the last amount this layout was drawn apart by, however it came to be.
  useEffect(() => {
    const remember = (s: TornoState): void => {
      const now = explodeNow(s)
      if (now) lastAmounts.set(keyOf(s), now.amount)
    }
    remember(store.getState())
    return store.subscribe(remember)
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (e: Event): void => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !more.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', close)
    }
  }, [open])

  const note = said ?? (apart ? `Parts drawn apart for display${scans ? ': the scans stay where they are' : ''}. E puts them together` : null)

  return (
    <div className="viewbar-group explode" role="group" aria-label="Explode" title={why ?? undefined} data-apart={apart ? '' : undefined}>
      <label className="explode-label" htmlFor="explode-amount">
        Explode
      </label>
      <input
        ref={slider}
        id="explode-amount"
        className="section-slider explode-slider"
        type="range"
        aria-label="Explode"
        title={why ?? 'How far apart the parts are drawn, for display only (E)'}
        min={0}
        max={100}
        step={1}
        defaultValue={shown}
        disabled={why !== null}
      />
      <span ref={amount} className="explode-amount num" data-disabled={why !== null ? '' : undefined} aria-hidden="true">
        {percent(shown)}
      </span>
      <div className="viewbar-more" ref={more}>
        <button type="button" className="bar-button bar-icon" aria-label="More" title="Along what the parts are set apart, and how far" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          <MoreIcon />
        </button>
        {open && (
          <div className="menu explode-more" role="group" aria-label="How the parts are drawn apart">
            <span className="explode-more-label">Direction</span>
            <div className="viewbar-group" role="group" aria-label="Direction">
              {AXES.map(({ axis, label, title }) => (
                <button
                  key={axis}
                  type="button"
                  className={axis === 'centre' ? 'bar-button' : 'bar-button section-axis num'}
                  data-axis={axis === 'centre' ? undefined : axis}
                  aria-pressed={kept.axis === axis}
                  title={title}
                  disabled={why === ONE_PART}
                  onClick={() => actions.setExplode({ axis })}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="explode-more-label">Distance</span>
            <div className="viewbar-group" role="group" aria-label="Distance">
              {SCALES.map((scale) => (
                <button key={scale} type="button" className="bar-button num" aria-pressed={kept.scale === scale} title={`${number(scale)} times the reach of the layout at 100 %`} disabled={why === ONE_PART} onClick={() => actions.setExplode({ scale })}>
                  ×{number(scale)}
                </button>
              ))}
            </div>
            <p className="explode-hint">For display only. Every pick, mark and measurement is of the parts as assembled.</p>
          </div>
        )}
      </div>
      {note !== null && (
        <span className="explode-note" role="status" data-refused={said !== null ? '' : undefined}>
          {note}
        </span>
      )}
    </div>
  )
}

function percent(value: number): string {
  return `${number(value)} %`
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
    </svg>
  )
}

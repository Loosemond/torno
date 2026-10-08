import { useEffect, useRef, useState } from 'react'
import type { ViewName } from '../../shared/view'
import { actions, store, useStore } from '../state/store'
import type { Viewport } from '../viewport/Viewport'

const MAIN_VIEWS: { view: ViewName; label: string; key: string }[] = [
  { view: 'iso', label: 'Iso', key: '1' },
  { view: 'front', label: 'Front', key: '2' },
  { view: 'right', label: 'Right', key: '3' },
  { view: 'top', label: 'Top', key: '4' }
]
const MORE_VIEWS: { view: ViewName; label: string }[] = [
  { view: 'back', label: 'Back' },
  { view: 'left', label: 'Left' },
  { view: 'bottom', label: 'Bottom' }
]

/** Where a key press belongs to something else: a field, or the session's terminal. */
const TYPING = 'input, textarea, select, [contenteditable], [data-region="session"]'

function setOrtho(viewport: Viewport, ortho: boolean): void {
  viewport.setOrtho(ortho)
  actions.setOrtho(ortho)
}

/** The palette floating at the top of the viewport: layout, standard views, projection, fit. */
export function ViewBar({ viewport }: { viewport: Viewport }) {
  const layouts = useStore((s) => s.scene?.layouts ?? NONE)
  const layout = useStore((s) => s.layout)
  const ortho = useStore((s) => s.ortho)
  const [moreOpen, setMoreOpen] = useState(false)
  const more = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      if (e.target instanceof Element && e.target.closest(TYPING)) return
      const named = MAIN_VIEWS.find((v) => v.key === e.key)
      if (named) viewport.setView(named.view, true)
      else if (e.key === 'f' || e.key === 'F') viewport.fit()
      else if (e.key === 'o' || e.key === 'O') setOrtho(viewport, !store.getState().ortho)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewport])

  useEffect(() => {
    if (!moreOpen) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !more.current?.contains(e.target as Node)) setMoreOpen(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', close)
    }
  }, [moreOpen])

  function showLayout(next: string) {
    actions.setLayout(next)
    // Layouts place the parts differently: frame the new one, from the same side.
    viewport.fit()
  }

  return (
    <div className="viewbar" role="toolbar" aria-label="View">
      {layouts.length > 1 && (
        <>
          <div className="viewbar-group" role="group" aria-label="Layout">
            {layouts.map((name) => (
              <button key={name} type="button" className="bar-button" aria-pressed={name === layout} onClick={() => showLayout(name)}>
                {name}
              </button>
            ))}
          </div>
          <span className="viewbar-rule" aria-hidden="true" />
        </>
      )}

      <div className="viewbar-group" role="group" aria-label="Standard views">
        {MAIN_VIEWS.map((v) => (
          <button key={v.view} type="button" className="bar-button" title={`${v.label} view (${v.key})`} onClick={() => viewport.setView(v.view, true)}>
            {v.label}
          </button>
        ))}
        <div className="viewbar-more" ref={more}>
          <button
            type="button"
            className="bar-button bar-icon"
            aria-label="More views"
            title="More views"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <ChevronIcon />
          </button>
          {moreOpen && (
            <div className="menu" role="menu">
              {MORE_VIEWS.map((v) => (
                <button
                  key={v.view}
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    viewport.setView(v.view, true)
                    setMoreOpen(false)
                  }}
                >
                  {v.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <span className="viewbar-rule" aria-hidden="true" />

      <div className="viewbar-group" role="group" aria-label="Projection">
        <button type="button" className="bar-button" aria-pressed={!ortho} title="Perspective (O)" onClick={() => setOrtho(viewport, false)}>
          Perspective
        </button>
        <button type="button" className="bar-button" aria-pressed={ortho} title="Orthographic (O)" onClick={() => setOrtho(viewport, true)}>
          Ortho
        </button>
      </div>
      <span className="viewbar-rule" aria-hidden="true" />

      <button type="button" className="bar-button" title="Fit the parts in view (F)" onClick={() => viewport.fit()}>
        Fit
      </button>
    </div>
  )
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
    </svg>
  )
}

const NONE: never[] = []

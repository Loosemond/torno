import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'

const LEFT_WIDTH = 248
const DOCK_DEFAULT = 520
const DOCK_MIN = 320
const VIEWPORT_MIN = 240 // free viewport width the dock always leaves beside the left column
const KEY_STEP = 16

function clampDock(width: number): number {
  const max = Math.max(DOCK_MIN, window.innerWidth - LEFT_WIDTH - VIEWPORT_MIN)
  return Math.round(Math.min(Math.max(width, DOCK_MIN), max))
}

export function App() {
  const shell = useRef<HTMLDivElement>(null)
  const [dockWidth, setDockWidth] = useState(DOCK_DEFAULT)
  const [dockOpen, setDockOpen] = useState(true)
  // While the edge is dragged the width goes straight to the CSS variable, so
  // React renders once at the end rather than on every pointer move.
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null)

  function onEdgeDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, startWidth: dockWidth, width: dockWidth }
    shell.current!.toggleAttribute('data-resizing', true)
  }

  function onEdgeMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    d.width = clampDock(d.startWidth + d.startX - e.clientX)
    shell.current!.style.setProperty('--dock-w', `${d.width}px`)
  }

  function onEdgeUp() {
    const d = drag.current
    if (!d) return
    drag.current = null
    shell.current!.toggleAttribute('data-resizing', false)
    setDockWidth(d.width)
  }

  function onEdgeKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    setDockWidth((w) => clampDock(w + (e.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP)))
  }

  return (
    <div
      ref={shell}
      className="shell"
      data-dock={dockOpen ? 'open' : 'collapsed'}
      style={{ '--dock-w': `${dockWidth}px` } as CSSProperties}
    >
      <main className="viewport" data-region="viewport">
        <div className="viewport-empty">
          <DatumMark />
          <h2>No object open</h2>
          <p>Choose an object in the left column to see its parts here.</p>
        </div>
      </main>

      <aside className="left" data-region="left" aria-label="Objects, layers and marks">
        <header className="panel-head">
          <h1 className="wordmark">torno</h1>
        </header>
        <p className="panel-note">No workspace open.</p>
      </aside>

      <aside className="dock" data-region="session" aria-label="Session" hidden={!dockOpen}>
        <div
          className="dock-edge"
          role="separator"
          aria-label="Resize session"
          aria-orientation="vertical"
          aria-valuenow={dockWidth}
          aria-valuemin={DOCK_MIN}
          tabIndex={0}
          onPointerDown={onEdgeDown}
          onPointerMove={onEdgeMove}
          onPointerUp={onEdgeUp}
          onPointerCancel={onEdgeUp}
          onKeyDown={onEdgeKey}
        />
        <header className="panel-head">
          <h2 className="panel-title">Session</h2>
        </header>
        <p className="panel-note">The agent's session starts here when you open an object.</p>
      </aside>

      <button
        type="button"
        className="dock-toggle"
        aria-label={dockOpen ? 'Hide session' : 'Show session'}
        aria-expanded={dockOpen}
        title={dockOpen ? 'Hide session' : 'Show session'}
        onClick={() => setDockOpen((open) => !open)}
      >
        <DockIcon />
      </button>

      <footer className="status" data-region="status">
        <span className="status-dot" aria-hidden="true" />
        <span>No build yet</span>
      </footer>
    </div>
  )
}

/** A scribed centre mark: where the part's origin will sit on the plate. */
function DatumMark() {
  return (
    <svg className="datum" viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
      <circle cx="22" cy="22" r="9.5" />
      <path d="M22 2.5v15M22 26.5v15M2.5 22h15M26.5 22h15" />
      <circle cx="22" cy="22" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

function DockIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" />
      <path d="M10 2.75v10.5" />
    </svg>
  )
}

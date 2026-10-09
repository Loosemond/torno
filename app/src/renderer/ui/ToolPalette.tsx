import { useEffect, type ReactNode } from 'react'
import { TOOLS, setTool, useTool, type ToolName } from '../state/tools'
import { TYPING } from './ViewBar'

/**
 * The tools, floating at the left edge of the viewport: what the pointer does
 * there. Each has a key, shown on its button, which works wherever the view
 * keys do.
 */
export function ToolPalette() {
  const tool = useTool()

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
    <div className="toolbox" role="toolbar" aria-label="Tools" aria-orientation="vertical">
      {TOOLS.map((t) => (
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
      ))}
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
  // A box, seen from a corner.
  shape: (
    <Icon>
      <path d="M8 1.750 13.500 4.750v6.500L8 14.250l-5.500-3v-6.500L8 1.750ZM2.500 4.750 8 7.750l5.500-3M8 7.750v6.500" />
    </Icon>
  )
}

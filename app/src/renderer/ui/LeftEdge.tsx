import { useEffect, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { which } from '../../shared/keys'
import { clampLeft, LEFT_DEFAULT } from '../state/column'
import { actions, useStore } from '../state/store'
import { giveKeysBack } from './typing'

const KEY_STEP = 16
const drag: { current: { startX: number; startWidth: number; width: number } | null } = { current: null }

/** The width the dock takes from the window right now: nothing while it is away. */
function dockSpace(shell: HTMLElement): number {
  const dock = shell.querySelector<HTMLElement>('.dock')
  return dock && !dock.hidden ? dock.getBoundingClientRect().width : 0
}

/**
 * The right edge of the left column (`role="separator"`): dragged, or moved with Left and Right, the column is
 * wider, up to what leaves the viewport its room beside the session dock, and never narrower than its default. A
 * double click puts the default back. While it is dragged the width goes straight to `--left-w` on the shell; the
 * store, and the window's storage with it, has it once the edge is let go. The shell has what is kept as far as
 * the window has room for it now, and what is kept is not touched.
 */
export function LeftEdge({ shell }: { shell: RefObject<HTMLDivElement | null> }) {
  const width = useStore((s) => s.column.width)
  const dockOpen = useStore((s) => s.dockOpen)
  const shown = width ?? LEFT_DEFAULT

  useEffect(() => {
    const el = shell.current
    if (!el) return
    const fit = (): void => {
      if (drag.current) return
      if (width === null) el.style.removeProperty('--left-w')
      else el.style.setProperty('--left-w', `${clampLeft(width, window.innerWidth, dockSpace(el))}px`)
    }
    fit()
    window.addEventListener('resize', fit)
    return () => {
      window.removeEventListener('resize', fit)
      el.style.removeProperty('--left-w')
    }
  }, [shell, width, dockOpen])

  function onDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const startWidth = e.currentTarget.parentElement!.getBoundingClientRect().width
    drag.current = { startX: e.clientX, startWidth, width: startWidth }
    shell.current?.toggleAttribute('data-resizing-left', true)
  }

  function onMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d || !shell.current) return
    d.width = clampLeft(d.startWidth + e.clientX - d.startX, window.innerWidth, dockSpace(shell.current))
    shell.current.style.setProperty('--left-w', `${d.width}px`)
  }

  function onUp(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    drag.current = null
    shell.current?.toggleAttribute('data-resizing-left', false)
    // A press that moved nothing (the first of a double click) keeps what there was.
    if (d.width !== d.startWidth) actions.setLeftWidth(d.width > LEFT_DEFAULT ? d.width : null)
    giveKeysBack(e.currentTarget)
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const way = which(e, 'left.resize')
    if (way < 0 || !shell.current) return
    e.preventDefault()
    const now = e.currentTarget.parentElement!.getBoundingClientRect().width
    const next = clampLeft(now + (way === 0 ? -KEY_STEP : KEY_STEP), window.innerWidth, dockSpace(shell.current))
    actions.setLeftWidth(next > LEFT_DEFAULT ? next : null)
  }

  return (
    <div
      className="left-edge"
      role="separator"
      aria-label="Resize left column"
      aria-orientation="vertical"
      aria-valuenow={shown}
      aria-valuemin={LEFT_DEFAULT}
      tabIndex={0}
      title="Drag to make the column wider; a double click puts the default back"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
      onDoubleClick={() => actions.setLeftWidth(null)}
    />
  )
}

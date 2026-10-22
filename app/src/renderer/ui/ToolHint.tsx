import { hint } from '../../shared/keys'
import { pointerLine } from '../../shared/pointer'
import { hintLine, useStep } from '../state/step'
import { useStore } from '../state/store'
import { toolStore, useTool } from '../state/tools'
import { useStore as useZustand } from 'zustand'
import { numbered } from './numbered'

/**
 * One quiet line at the foot of the view. With a tool in hand it says what the tool waits for next (`stepFor`), and
 * that Esc steps back; with none, the first time an object is drawn in this install, it says how the pointer turns,
 * pans and zooms the view, and goes at the first move of the camera (`pointerMoved`). It names no key of a tool.
 * It takes no pointer, and changes once per step: the tools tell it through the store, never per move. Where the
 * bars at the bottom stand it lifts them by its own height (`--hint-lift`, `styles/layout.css`), so none meets it.
 */
export function ToolHint() {
  const tool = useTool()
  const stage = useStep((s) => s.stage)
  const due = useStep((s) => s.due)
  const replacing = useZustand(toolStore, (s) => s.replacing?.id ?? null)
  const scans = useStore((s) => (s.scansKnown ? s.scans.length : null))
  const line = hintLine({ tool, stage, replacing, scans, due })
  return (
    // The region is always there, so that what comes into it is read out.
    <div className="tool-hint-live" aria-live="polite">
      {line && (
        <p className="tool-hint" data-kind={line.kind}>
          {line.kind === 'step' ? (
            <>
              <span className="tool-hint-text">{numbered(line.text)}</span>
              <span className="tool-hint-stop">
                <kbd className="num">{hint('escape')}</kbd> steps back
              </span>
            </>
          ) : (
            <>
              <span className="tool-hint-text">{pointerLine()}</span>
              <span className="tool-hint-stop">
                <kbd className="num">{hint('keys')}</kbd> for every key
              </span>
            </>
          )}
        </p>
      )}
    </div>
  )
}

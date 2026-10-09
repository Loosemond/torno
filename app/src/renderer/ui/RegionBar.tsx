import { numbered } from './numbered'
import { count as counted, number } from '../../shared/format'
import { alignmentOf } from '../../shared/scans'
import { useAgentHighlight } from '../state/agent'
import { scanInHand, useAlign } from '../state/align'
import { BOX_NOTE, THROUGH_NOTE, type RegionMode, nextLine, radiusOf, regionStore, useRegion, usualRadius } from '../state/region'
import { useStore } from '../state/store'
import { useTool } from '../state/tools'
import { clearRegion, growRegion, keepRegion, undoStroke } from '../tools/regionTool'
import { Field } from './AlignBar'

const MODES: { mode: RegionMode; label: string; title: string }[] = [
  { mode: 'brush', label: 'Brush', title: 'Drag over the scan to paint it where it is seen. Ctrl-drag takes paint off' },
  { mode: 'box', label: 'Box', title: `Drag a box on the screen. ${BOX_NOTE}. Shift-drag does the same while the brush is chosen` }
]

/**
 * The bar of the Region tool, while it is in hand: how the scan is painted (a brush of a radius, or a box),
 * whether the brush takes paint off, growing what is painted over what lies flat with it, taking the last
 * stroke back, and how much is painted. "Keep" has main keep it as a mark and opens its note (or, of a region
 * being painted again, makes it that region); "Clear" puts it down, and Undo brings that back. One line says
 * what to do next. Nothing here changes with a pointer move: the count is told when a stroke ends.
 */
export function RegionBar() {
  const inHand = useTool() === 'region'
  const state = useRegion((s) => s)
  const scans = useStore((s) => s.scans)
  const layout = useStore((s) => s.layout)
  const aligning = useAlign((s) => s.scan)
  const section = useStore((s) => s.section !== null)
  const selected = useStore((s) => s.selection.length > 0)
  const pointedOut = useAgentHighlight() !== null
  if (!inHand) return null
  const { mode, radius, erase, through, count, area, canUndo, sending, refused, scan, editing } = state
  // The scan the brush is sized for while none is painted on: the one being aligned, or the only one.
  const sized = scans.find((one) => one.id === scan) ?? scanInHand(aligning, scans)
  const usual = sized ? usualRadius(sized, alignmentOf(sized, layout)?.transform.s ?? 1) : null
  const painted = count > 0
  // Above the section's bar, the selection and what the agent points at: each has a row of its own at the bottom edge.
  const raised = (section ? 1 : 0) + (selected ? 1 : 0) + (pointedOut ? 1 : 0)
  const shown = radius ?? usual

  return (
    <div className="regionbar" role="toolbar" aria-label="Region" data-raised={raised || undefined}>
      <div className="regionbar-row">
        <div className="segmented" role="radiogroup" aria-label="How to paint">
          {MODES.map((m) => (
            <button key={m.mode} type="button" role="radio" title={m.title} aria-checked={m.mode === mode} aria-pressed={m.mode === mode} onClick={() => regionStore.setState({ mode: m.mode })}>
              {m.label}
            </button>
          ))}
        </div>
        {mode === 'brush' ? (
          <>
            <span className="regionbar-label" title="How far the brush reaches round the pointer. [ and ] change it by a quarter">
              Radius
            </span>
            <span aria-keyshortcuts="[ ]">
              <Field label="Brush radius" unit="mm" value={shown === null ? '' : number(shown)} commit={(value) => regionStore.setState({ radius: radiusOf(value) })} />
            </span>
          </>
        ) : (
          <button type="button" className="bar-button" aria-pressed={through} title={`${THROUGH_NOTE}: what faces away from you as well`} onClick={() => regionStore.setState({ through: !through })}>
            Through
          </button>
        )}
        <button type="button" className="bar-button" aria-pressed={erase} aria-keyshortcuts="E" title="The brush, and a box, take paint off (E). Ctrl-drag does it for one stroke" onClick={() => regionStore.setState({ erase: !erase })}>
          Erase
        </button>
        <span className="regionbar-rule" aria-hidden="true" />
        <button type="button" className="bar-button" disabled={!painted || sending} title="Spreads what is painted over what lies flat with it: within 2 mm of its plane, turned no more than 15° from it" onClick={growRegion}>
          Grow to flat
        </button>
        <button type="button" className="bar-button" disabled={!canUndo || sending} aria-keyshortcuts="Z" title="Takes back the last stroke, or brings back what Clear put down (Z)" onClick={undoStroke}>
          Undo
        </button>
      </div>
      <p className="regionbar-next" role="status">
        {numbered(nextLine(state, scans.length))}
      </p>
      <div className="regionbar-row" data-part="foot">
        <span className="regionbar-count" data-empty={painted ? undefined : ''} title={painted ? `On ${scan}. The area is of the scan's mesh: approximate` : undefined}>
          {editing && <span className="num">{editing} · </span>}
          {scan && painted && <span className="num">{scan} · </span>}
          <span className="num">{counted(count)}</span> {count === 1 ? 'triangle' : 'triangles'}
          {painted && (
            <>
              {' · ≈ '}
              <span className="num">{number(area)}</span> mm²
            </>
          )}
        </span>
        <button type="button" className="bar-button" disabled={(!painted && !editing) || sending} title={editing ? `Puts the painting down: ${editing} stays as it was. Undo brings the painting back` : 'Puts down what is painted, without keeping it. Undo brings it back'} onClick={clearRegion}>
          Clear
        </button>
        <button type="button" className="bar-button regionbar-keep" disabled={!painted || sending} aria-keyshortcuts="Enter" title={editing ? `Makes what is painted the triangles of ${editing} (Enter)` : 'Keeps it as a mark and opens its note, to say what it is (Enter)'} onClick={() => void keepRegion()}>
          Keep
        </button>
      </div>
      {refused && (
        <p className="regionbar-note selectable" role="alert" data-part="refused">
          {numbered(refused)}
        </p>
      )}
    </div>
  )
}

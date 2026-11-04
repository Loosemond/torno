import { useMemo, useState, type ReactNode } from 'react'
import { number } from '../../shared/format'
import { pressed } from '../../shared/keys'
import { type ScanInfo, type ScanUnit, type ScanUp, UNIT_MM, sizeAgainst, sizeAs } from '../../shared/scans'
import type { Vec3 } from '../../shared/marks'
import { actions, useStore } from '../state/store'
import { Confirm } from './Confirm'
import { numbered } from './numbered'
import { UNIT_WORD } from './scanState'
import { chosen, pointerChoice } from './typing'

/** The sides of the box that holds all these, or null of none. */
function sizeOfBoxes(boxes: Array<{ min: Vec3; max: Vec3 }>): Vec3 | null {
  if (boxes.length === 0) return null
  const lo = [0, 1, 2].map((a) => Math.min(...boxes.map((b) => b.min[a])))
  const hi = [0, 1, 2].map((a) => Math.max(...boxes.map((b) => b.max[a])))
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
}

/** `About 1,000 times`, or `About 1/1,000 of`: to two figures. */
function timesText(ratio: number): string {
  const two = (n: number): string => Number(n.toPrecision(2)).toLocaleString('en-US')
  return ratio >= 1 ? `About ${two(ratio)} times` : `About 1/${two(1 / ratio)} of`
}

const UNITS = Object.keys(UNIT_MM) as ScanUnit[]

/**
 * How a scan this window just imported is read, asked once, at the top of the Scans section: torno guessed its
 * unit or its up axis from the format and the size, and a wrong unit is a thousandfold. The scan is drawn in the
 * view meanwhile, which is the preview; the size it would have is said here. Not modal: "Later" (or Escape) puts
 * it away, and the question stays in the scan's detail.
 */
export function ScanReadSheet({ scan, convert, layoutsOf }: { scan: ScanInfo; convert: (as: { unit: ScanUnit; up: ScanUp }) => Promise<void>; layoutsOf: (names: string[]) => ReactNode }) {
  const { id, imported } = scan
  const [unit, setUnit] = useState<ScanUnit>(imported.unit)
  const [up, setUp] = useState<ScanUp>(imported.up)
  const [asking, setAsking] = useState(false)
  const changed = unit !== imported.unit || up !== imported.up
  const layouts = Object.keys(scan.alignments)
  const size = sizeAs(imported, { unit, up })
    .map((c) => number(c))
    .join(' × ')
  const scene = useStore((s) => s.scene)
  const layout = useStore((s) => s.layout)
  const parts = useMemo(() => scene?.parts.filter((part) => part.layout === layout) ?? [], [scene, layout])
  const partsSize = sizeOfBoxes(parts.map((part) => part.bbox))
  const against = partsSize ? sizeAgainst(sizeAs(imported, { unit, up }), partsSize, unit) : null
  const exact = parts.length > 0 && parts.every((part) => part.bboxExact === true)
  const done = (as: { unit: ScanUnit; up: ScanUp }): void => {
    actions.askScanRead(null)
    // A scan read another way has another size: it is brought into view again once main has it so.
    void convert(as).then(() => {
      if (as.unit !== imported.unit || as.up !== imported.up) actions.frameScan(id)
    })
  }

  return (
    <div
      className="scan-sheet"
      role="dialog"
      aria-label={`How is ${id} read?`}
      onKeyDown={(e) => {
        if (!asking && pressed(e, 'sheet.close')) {
          e.stopPropagation()
          actions.askScanRead(null)
        }
      }}
    >
      <p className="scan-sheet-text">
        <span className="num">{id}</span> was read as {UNIT_WORD[imported.unit]}, {imported.up.toUpperCase()} up: torno guessed from the format and the size.
      </p>
      <p className="scan-sheet-size" data-part="size">
        {numbered(`Its size would be ${size} mm`)}
      </p>
      {partsSize && (
        <p className="scan-sheet-size" data-part="parts">
          {numbered(`${parts.length === 1 ? 'The part' : 'The parts'} of ${layout}: about ${partsSize.map((c) => number(c)).join(' × ')} mm${exact ? '' : ', as drawn'}`)}
        </p>
      )}
      {against?.suggest && (
        <p className="scan-sheet-warn" data-part="doubt">
          {numbered(`${timesText(against.ratio)} the parts: is it in ${UNIT_WORD[against.suggest]}?`)}
        </p>
      )}
      <div className="scan-field">
        <select
          className="scan-select num"
          aria-label={`Unit of ${id}`}
          value={unit}
          {...pointerChoice}
          onChange={(e) => {
            setUnit(e.target.value as ScanUnit)
            chosen(e.currentTarget)
          }}
        >
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <select
          className="scan-select"
          aria-label={`Up axis of ${id}`}
          value={up}
          {...pointerChoice}
          onChange={(e) => {
            setUp(e.target.value as ScanUp)
            chosen(e.currentTarget)
          }}
        >
          <option value="y">Y up</option>
          <option value="z">Z up</option>
        </select>
      </div>
      <div className="scan-sheet-actions">
        <button type="button" className="button" title="Keeps the scan as it was read, and no longer asks" onClick={() => done({ unit: imported.unit, up: imported.up })}>
          Keep
        </button>
        <button type="button" className="button" title={changed ? undefined : 'Choose another unit or up axis first'} disabled={!changed} onClick={() => (layouts.length > 0 ? setAsking(true) : done({ unit, up }))}>
          Apply
        </button>
        <button type="button" className="button button-quiet" title="Asks again in the scan's detail" onClick={() => actions.askScanRead(null)}>
          Later
        </button>
      </div>
      {asking && (
        <Confirm label={`Drop the alignment of ${id}?`} accept="Change" cancel="Keep as it is" onCancel={() => setAsking(false)} onAccept={() => done({ unit, up })}>
          Changing the unit or the up axis of <span className="num">{id}</span> drops its alignment in {layoutsOf(layouts)}.
        </Confirm>
      )}
    </div>
  )
}

import { useState } from 'react'
import type { Vec3 } from '../../../shared/marks'
import { type ScanAlignment, IDENTITY } from '../../../shared/scans'
import { type AlignState, alignStore, movedAlignment } from '../../state/align'
import { anglesWith, keepAlignment } from '../../tools/alignTool'
import { eulerOf, quatOf } from '../../tools/shapeTool'
import { Field } from '../Field'
import { AXES, shown } from './format'

/**
 * Where the scan's own origin is, in millimetres, and how the scan is turned, in degrees about X, then Y,
 * then Z, as a shape's are shown. Many triples of angles are one turn: while the angles are typed the three
 * typed are the three shown, and they are worked out again once the scan is turned some other way.
 */
export function NudgeBody({ state, current, disabled }: { state: AlignState; current: ScanAlignment | null; disabled: boolean }) {
  const transform = current?.transform ?? IDENTITY
  const [angles, setAngles] = useState<Vec3 | null>(null)
  // A rotation and its negative are the same turn.
  const sameTurn = (a: readonly number[], b: readonly number[]): boolean => Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) > 1 - 1e-9
  // In full: a field shows two decimals, and typing one angle leaves the other two as they are, not as they are shown.
  const degrees = angles && sameTurn(quatOf(angles), transform.q) ? angles : eulerOf(transform.q)
  const withOne = (of: Vec3, index: number, value: number): Vec3 => of.map((c, i) => (i === index ? value : c)) as Vec3
  const keep = (made: ScanAlignment['transform']): void => void keepAlignment(movedAlignment(current, made, 'typed'))
  return (
    <div className="alignbar-body" data-mode="nudge">
      <div className="alignbar-row">
        <span className="alignbar-label">
          Origin <span className="num">mm</span>
        </span>
        {AXES.map((axis, i) => (
          <Field key={axis} label={axis.toUpperCase()} sign={axis} axis={axis} value={shown(transform.t[i])} disabled={disabled} commit={(value) => keep({ ...transform, t: withOne(transform.t, i, value) })} />
        ))}
      </div>
      <div className="alignbar-row">
        <span className="alignbar-label">
          Turned <span className="num">°</span>
        </span>
        {AXES.map((axis, i) => (
          <Field
            key={axis}
            label={`R${axis.toUpperCase()}`}
            sign={axis}
            axis={axis}
            value={shown(degrees[i])}
            disabled={disabled}
            commit={(value) => {
              const next = anglesWith(angles, transform.q, i, value)
              // Kept as typed while the scan is turned so: the same turn has many triples of angles.
              setAngles(next)
              keep({ ...transform, q: quatOf(next) })
            }}
          />
        ))}
        <div className="segmented" role="group" aria-label="What the handles do">
          <button type="button" aria-pressed={state.handle === 'translate'} aria-keyshortcuts="G" title="Move the scan with the handles in the view (G)" onClick={() => alignStore.setState({ handle: 'translate' })}>
            Move
            <kbd className="num" aria-hidden="true">
              G
            </kbd>
          </button>
          <button type="button" aria-pressed={state.handle === 'rotate'} aria-keyshortcuts="R" title="Turn the scan with the handles in the view (R)" onClick={() => alignStore.setState({ handle: 'rotate' })}>
            Turn
            <kbd className="num" aria-hidden="true">
              R
            </kbd>
          </button>
        </div>
      </div>
    </div>
  )
}

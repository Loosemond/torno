import { pressed } from '../../shared/keys'
import { useEffect, useRef, useState } from 'react'
import type { MarkPatch, Quat, ShapeIntent, ShapeMark, Vec3 } from '../../shared/marks'
import { GIZMO_MODES, setGizmo, useGizmo } from '../state/tools'
import { eulerOf, quatOf } from '../tools/shapeTool'
import { giveKeysBack } from './typing'
import { fitSize } from '../viewport/marks/markObjects'

const INTENTS: { intent: ShapeIntent; label: string; title: string }[] = [
  { intent: 'add', label: 'Add', title: 'Material to add here' },
  { intent: 'remove', label: 'Remove', title: 'Material to take away here' },
  { intent: 'keep-out', label: 'Keep out', title: 'Room the part must leave free' },
  { intent: 'reference', label: 'Reference', title: 'Only to show where or how large: nothing to make' }
]

type Axis = 'x' | 'y' | 'z'
/** The numbers of a size that are shown, by shape: which of the three each is, what it is called, and the axis it runs along, if one. */
const SIZE_FIELDS: Record<ShapeMark['shape'], { index: 0 | 1 | 2; name: string; sign: string; axis?: Axis }[]> = {
  box: [
    { index: 0, name: 'Size along X', sign: 'x', axis: 'x' },
    { index: 1, name: 'Size along Y', sign: 'y', axis: 'y' },
    { index: 2, name: 'Size along Z', sign: 'z', axis: 'z' }
  ],
  cylinder: [
    { index: 0, name: 'Diameter', sign: '⌀' },
    { index: 2, name: 'Height', sign: 'h', axis: 'z' }
  ],
  sphere: [{ index: 0, name: 'Diameter', sign: '⌀' }],
  plane: [
    { index: 0, name: 'Width', sign: 'w', axis: 'x' },
    { index: 1, name: 'Height', sign: 'h', axis: 'y' }
  ]
}
const AXES: Axis[] = ['x', 'y', 'z']
type Transform = Pick<ShapeMark, 'position' | 'rotation' | 'size'>

/** A number as a field shows it: to the hundredth, without the zeros that say nothing. */
function shown(value: number): string {
  return String(Math.round(value * 100) / 100 + 0)
}

function sameRotation(a: Quat, b: Quat): boolean {
  // A rotation and its negative are the same turn.
  return Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) > 1 - 1e-9
}

/**
 * The numbers of a shape, in its row of the marks panel while it is the active
 * mark: what it is for, where it is, how it is turned and how large it is, all
 * to be typed over, and what dragging its gizmo does. A number is sent when
 * its field is left or Enter is pressed; Escape puts back what was there.
 *
 * Rotation is shown as degrees about the shape's X, Y and Z, and kept as a
 * quaternion. Many triples of angles are the same turn, so while the angles
 * are being typed the three typed are the three shown: they are worked out
 * again from the quaternion only once the fields are left, or the shape is
 * turned some other way.
 */
export function ShapeFields({ mark, change }: { mark: ShapeMark; change: (patch: MarkPatch) => Promise<unknown> }) {
  const mode = useGizmo()
  /** The angles as typed, for as long as they are what the shape is turned by: three angles read back from a quaternion are others, and would jump under the hand. */
  const [typed, setTyped] = useState<Vec3 | null>(null)
  /**
   * What has been sent and main has not yet told back. The next number typed
   * builds on it: three sizes typed one after the other are three changes, and
   * the second must not put back the first.
   */
  const sent = useRef<Partial<Transform>>({})

  useEffect(() => {
    for (const key of ['position', 'rotation', 'size'] as const) {
      const waiting = sent.current[key]
      if (waiting && waiting.every((n, i) => n === mark[key][i])) delete sent.current[key]
    }
    // Turned by the gizmo, or by the agent: the angles typed are no longer what it is.
    setTyped((angles) => (angles && !sameRotation(quatOf(angles), mark.rotation) ? null : angles))
  }, [mark])

  const now = (): Transform => ({ position: mark.position, rotation: mark.rotation, size: mark.size, ...sent.current })
  const send = (patch: Partial<Transform>): void => {
    Object.assign(sent.current, patch)
    change(patch).catch(() => {
      // Refused, and the panel says so: what was sent is not on its way any more.
      for (const key of Object.keys(patch) as (keyof Transform)[]) if (sent.current[key] === patch[key]) delete sent.current[key]
    })
  }
  const withOne = (of: Vec3, index: number, value: number): Vec3 => of.map((n, i) => (i === index ? value : n)) as Vec3

  const angles = typed ?? (eulerOf(mark.rotation).map((degrees) => Math.round(degrees * 100) / 100 + 0) as Vec3)

  return (
    <div className="shape-fields" onClick={(e) => e.stopPropagation()}>
      <div className="segmented" role="group" aria-label={`What ${mark.id} is for`}>
        {INTENTS.map((i) => (
          <button key={i.intent} type="button" title={i.title} aria-pressed={i.intent === mark.intent} onClick={() => i.intent !== mark.intent && void change({ intent: i.intent }).catch(() => {})}>
            {i.label}
          </button>
        ))}
      </div>

      <fieldset className="shape-group">
        <legend>
          Position <span className="num">mm</span>
        </legend>
        {AXES.map((axis, i) => (
          <NumberField key={axis} name={`Position ${axis.toUpperCase()}`} sign={axis} axis={axis} value={mark.position[i]} commit={(value) => send({ position: withOne(now().position, i, value) })} />
        ))}
      </fieldset>

      {/* The angles stay as they were typed after the focus has left them (Enter gives the keys back to the view): they are what the shape is turned by until something else turns it. */}
      <fieldset className="shape-group">
        <legend>
          Rotation <span className="num">°</span>
        </legend>
        {AXES.map((axis, i) => (
          <NumberField
            key={axis}
            name={`Rotation about ${axis.toUpperCase()}`}
            sign={axis}
            axis={axis}
            value={angles[i]}
            commit={(value) => {
              const next = withOne(angles, i, value)
              setTyped(next)
              send({ rotation: quatOf(next) })
            }}
          />
        ))}
      </fieldset>

      <fieldset className="shape-group">
        <legend>
          Size <span className="num">mm</span>
        </legend>
        {SIZE_FIELDS[mark.shape].map((f) => (
          <NumberField
            key={f.index}
            name={f.name}
            sign={f.sign}
            axis={f.axis}
            value={mark.size[f.index]}
            commit={(value) => {
              const from = now().size
              send({ size: fitSize(mark.shape, withOne(from, f.index, value), from) })
            }}
          />
        ))}
      </fieldset>

      <div className="shape-drag">
        <span id={`drag-${mark.id}`}>Drag to</span>
        <div className="segmented" role="group" aria-labelledby={`drag-${mark.id}`}>
          {GIZMO_MODES.map((m) => (
            <button key={m.mode} type="button" aria-label={m.label} aria-pressed={m.mode === mode} aria-keyshortcuts={m.key} title={`${m.label} with the handles in the view (${m.key})`} onClick={() => setGizmo(m.mode)}>
              {m.label}
              <kbd className="num" aria-hidden="true">
                {m.key}
              </kbd>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * One number, to be typed over. `commit` is given the number when the field is
 * left or Enter is pressed, if it is a number and not the one that was there.
 */
function NumberField({ name, sign, axis, value, commit }: { name: string; sign: string; axis?: Axis; value: number; commit: (value: number) => void }) {
  // What is being typed; null while the field only shows the number.
  const [draft, setDraft] = useState<string | null>(null)
  /** Kept already: Enter keeps what was typed, and the focus that then leaves the field must not keep it again. */
  const kept = useRef(false)
  const done = (): void => {
    if (draft === null || kept.current) return
    kept.current = true
    setDraft(null)
    const text = draft.trim().replace(',', '.')
    const typed = text === '' ? Number.NaN : Number(text)
    if (Number.isFinite(typed) && typed !== value) commit(typed)
  }
  return (
    <label className="shape-field" data-axis={axis}>
      <span className="shape-sign num" aria-hidden="true">
        {sign}
      </span>
      <input
        className="num"
        type="text"
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        aria-label={name}
        value={draft ?? shown(value)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          kept.current = false
          setDraft(e.target.value)
        }}
        onBlur={done}
        onKeyDown={(e) => {
          if (pressed(e, 'field.keep')) done()
          else if (pressed(e, 'field.leave')) {
            // Left as it was: the blur that follows keeps nothing of what was typed.
            kept.current = true
            setDraft(null)
          } else return
          e.preventDefault()
          e.stopPropagation()
          giveKeysBack(e.currentTarget)
        }}
      />
    </label>
  )
}

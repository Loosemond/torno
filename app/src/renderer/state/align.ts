import { useStore as useZustand } from 'zustand'
import { type StoreApi, createStore } from 'zustand/vanilla'
import { type PairFit, apply, compose, fitFew, fitPairs, inverse, rotate, toFloor, unitHint } from '../../shared/align'
import { number } from '../../shared/format'
import type { Vec3 } from '../../shared/marks'
import { type NewAlignment, type ScanAlignment, type ScanInfo, type ScanPair, type ScanTransform, type ScanUnit, IDENTITY } from '../../shared/scans'

/** How a scan is being aligned: by laying its floor down, by pairs of points, or by hand. */
export type AlignMode = 'floor' | 'pairs' | 'nudge'
/** A pair being made: a point of the scan, in the scan's own frame, and where it belongs on the model, in the object frame. Either may still be missing. */
export interface PairDraft { scan?: Vec3 /* scan frame */; model?: Vec3 /* object frame */; part?: string }
/** A patch of the scan taken for its floor: its plane in the object frame, as the scan stands where main has it, how many triangles it was fitted to (`used`, of `of`), and a direction its seen side looks towards. */
export interface FloorDraft { plane: { origin: Vec3; normal: Vec3; rms: number; used: number }; facing: Vec3; of?: number }

/** What the Align tool has in hand: changed by a click, a key or a field, never by a pointer move. */
export interface AlignState {
  scan: string | null
  mode: AlignMode
  pairs: PairDraft[]
  /** The person chose to keep the size the pairs fit to ("Keep this scale"). */
  scale: boolean
  floor: FloorDraft | null
  /** What the floor is laid on: the ground at `height`, or a face of the model. */
  onto: { origin: Vec3; normal: Vec3; part?: string } | null
  height: number
  /** The next click on a part chooses the face to lay the floor on. */
  choosingFace: boolean
  /** The floor is laid the other way up. */
  flip: boolean
  /** Points of the scan clicked with Shift, for a floor through three of them: object frame, as the scan stands where main has it. */
  points: Vec3[]
  /** Where the gizmo holds the scan, in the scan's own frame: the last point clicked on it while it is moved by hand. Null for the middle of its box. */
  pivot: Vec3 | null
  /** What the handles on the scan do while it is moved by hand. */
  handle: 'translate' | 'rotate'
  /** An alignment that is rough, waiting for the person's yes, and why it is. */
  asking: { made: NewAlignment; why: string } | null
  /** An alignment main was asked to keep and has not answered for yet: the scan is drawn there meanwhile. */
  sending: NewAlignment | null
  /** Why main did not keep the last alignment asked of it. */
  refused: string | null
  /** Counts the times the handles are to be put on the scan anew, as it then is: a drag was not kept. */
  again: number
}

const NOTHING_IN_HAND = { pairs: [], floor: null, onto: null, choosingFace: false, flip: false, points: [], asking: null, sending: null, refused: null } satisfies Partial<AlignState>

export const alignStore: StoreApi<AlignState> = createStore<AlignState>(() => ({ scan: null, mode: 'pairs', scale: false, height: 0, pivot: null, handle: 'translate', again: 0, ...NOTHING_IN_HAND }))

export function useAlign<T>(pick: (s: AlignState) => T): T {
  return useZustand(alignStore, pick)
}

/** Puts down what is in hand of an alignment being made: the pairs, the floor, a question that waits. Which scan, which way and where it is held stay. */
export function dropDraft(): void {
  alignStore.setState({ ...NOTHING_IN_HAND, scale: false })
}

/** Another scan to align, or none: what was in hand was of the one before. */
export function setAlignScan(scan: string | null): void {
  if (alignStore.getState().scan !== scan) alignStore.setState({ ...NOTHING_IN_HAND, scale: false, pivot: null, scan })
}

/** Another way of aligning: what was in hand of the one before is put down. */
export function setAlignMode(mode: AlignMode): void {
  if (alignStore.getState().mode !== mode) alignStore.setState({ ...NOTHING_IN_HAND, scale: false, mode })
}

/** The scan the tool works on: the one chosen, while it is still a scan of the object; else the one scan there is; else none. */
export function scanInHand(chosen: string | null, scans: ScanInfo[]): ScanInfo | null {
  return scans.find((scan) => scan.id === chosen) ?? (scans.length === 1 ? scans[0] : null)
}

/** A point of the scan was clicked: it is the scan end of the first pair that has none, or of a new pair. */
export function withScanEnd(pairs: PairDraft[], local: Vec3): PairDraft[] {
  const at = pairs.findIndex((pair) => pair.scan === undefined)
  return at < 0 ? [...pairs, { scan: local }] : pairs.map((pair, i) => (i === at ? { ...pair, scan: local } : pair))
}

/** A point of the model was clicked or typed: the model end of the first pair that has none, or of a new pair. */
export function withModelEnd(pairs: PairDraft[], point: Vec3, part?: string): PairDraft[] {
  const end: PairDraft = { model: point, ...(part === undefined ? {} : { part }) }
  const at = pairs.findIndex((pair) => pair.model === undefined)
  return at < 0 ? [...pairs, end] : pairs.map((pair, i) => (i === at ? { ...pair, ...end } : pair))
}

/** The model end of one pair, typed: it is on no part. A pair past the last is a new one. */
export function withTypedEnd(pairs: PairDraft[], at: number, point: Vec3): PairDraft[] {
  if (at >= pairs.length) return [...pairs, { model: point }]
  return pairs.map((pair, i) => (i === at ? { ...(pair.scan ? { scan: pair.scan } : {}), model: point } : pair))
}

/** Which end the next click is expected to give: the model's while a pair has only its scan end, the scan's otherwise. */
export function expects(pairs: PairDraft[]): 'scan' | 'model' {
  const open = pairs.find((pair) => pair.scan === undefined || pair.model === undefined)
  return open && open.scan !== undefined ? 'model' : 'scan'
}

type Whole = Required<Pick<PairDraft, 'scan' | 'model'>> & Pick<PairDraft, 'part'>
const wholeOf = (pairs: PairDraft[]): Whole[] => pairs.filter((pair): pair is Whole => pair.scan !== undefined && pair.model !== undefined)

/** What the whole pairs fit to: null with fewer than three. */
export function fitOf(pairs: PairDraft[], scale: boolean): PairFit | { error: string } | null {
  const whole = wholeOf(pairs)
  return whole.length < 3 ? null : fitPairs(whole.map((pair) => pair.scan), whole.map((pair) => pair.model), { scale })
}

const paired = (pairs: PairDraft[], fit: PairFit): ScanPair[] => wholeOf(pairs).map((pair, i) => ({ scan: pair.scan, model: pair.model, ...(pair.part === undefined ? {} : { part: pair.part }), residual: fit.residuals[i] }))
/** The steps an alignment was made by, with one more: the same step is not said twice in a row. */
const stepped = (current: ScanAlignment | null, step: ScanAlignment['steps'][number]): ScanAlignment['steps'] => {
  const steps = current?.steps ?? []
  return steps[steps.length - 1] === step ? [...steps] : [...steps, step]
}
/** What an alignment keeps of the one it is added to. */
const carried = (current: ScanAlignment | null): Partial<NewAlignment> => ({
  ...(current?.pairs ? { pairs: current.pairs } : {}),
  ...(current?.rms === undefined ? {} : { rms: current.rms }),
  ...(current?.floor ? { floor: current.floor } : {}),
  ...(current?.scaled ? { scaled: true } : {})
})

/** A fit of three pairs or more starts over: whatever was before it is superseded. */
export function pairsAlignment(pairs: PairDraft[], fit: PairFit): NewAlignment {
  return { transform: fit.transform, steps: ['pairs'], pairs: paired(pairs, fit), rms: fit.rms, ...(Math.abs(fit.transform.s - 1) > 1e-9 ? { scaled: true } : {}) }
}

/** What fewer than three pairs, or pairs in a line, make of the scan as it stands (`fitFew`): added to what there is, a floor before it kept. */
export function fewAlignment(current: ScanAlignment | null, pairs: PairDraft[], fit: PairFit): NewAlignment {
  return { ...carried(current), transform: fit.transform, steps: stepped(current, 'pairs'), pairs: paired(pairs, fit), rms: fit.rms }
}

/**
 * The floor laid down: composed on what there is. Onto a face of the model it is laid the way that turns the
 * scan least (a floor and the underside of what stands on it face each other, a scanned surface and the
 * model's own face the same way: neither puts the scan on its head); `flip` lays it the other way up.
 */
export function floorAlignment(current: ScanAlignment | null, floor: FloorDraft, onto: AlignState['onto'], height: number, flip = false): NewAlignment {
  const seen = dot(floor.plane.normal, floor.facing) < 0 ? negated(floor.plane.normal) : floor.plane.normal
  const towards = onto ? (dot(seen, onto.normal) < 0 ? negated(onto.normal) : onto.normal) : ([0, 0, 1] as Vec3)
  const point: Vec3 = onto ? onto.origin : [0, 0, height]
  const move = toFloor({ origin: floor.plane.origin, normal: seen }, seen, { origin: point, normal: flip ? negated(towards) : towards })
  return { ...carried(current), transform: compose(move, current?.transform ?? IDENTITY), steps: stepped(current, 'floor'), rms: floor.plane.rms, floor: { ...(onto?.part === undefined ? {} : { part: onto.part }), point } }
}

/** The scan put somewhere by hand or by typed values: `transform` is where it then stands. Its pairs are kept, and say how far off they now are. */
export function movedAlignment(current: ScanAlignment | null, transform: ScanTransform, step: 'nudge' | 'typed'): NewAlignment {
  return { ...carried(current), transform, steps: stepped(current, step) }
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const negated = (v: Vec3): Vec3 => [-v[0] + 0, -v[1] + 0, -v[2] + 0]

/** A floor's patch is no floor when it is this bumpy (rms, mm), or when less than this share of it lies in its plane. */
export const FLOOR_RMS_MM = 2
export const FLOOR_KEPT = 0.8
/** Said of a patch that is not flat enough to be a floor, or null. */
export function floorWarning(floor: FloorDraft): string | null {
  const share = floor.of ? floor.plane.used / floor.of : 1
  return floor.plane.rms > FLOOR_RMS_MM || share < FLOOR_KEPT ? 'this patch is not flat: pick a flatter one' : null
}

/** What is said of a fit's size: a unit, a per cent, or nothing. */
export function sizeNote(fit: Pick<PairFit, 'freeScale'>, unit: ScanUnit): string | null {
  const hint = unitHint(fit.freeScale, unit)
  if (hint) {
    const [times, way] = hint.factor >= 1 ? [hint.factor, 'larger'] : [1 / hint.factor, 'smaller']
    return `These points fit ${number(times)} × ${way}: this scan looks like it is in ${hint.unit}, and was imported as ${unit}. Change its unit on its row.`
  }
  if (!(Math.abs(fit.freeScale - 1) > 0.005)) return null
  // A free scale under one: the scan must shrink to fit, so it measures larger than the model.
  return `The scan measures ${number(Math.abs(1 - fit.freeScale) * 100)} % ${fit.freeScale < 1 ? 'larger' : 'smaller'} than the model between these points.`
}

/**
 * What is in hand would make of the scan, were it applied: the alignment, and of pairs their fit. `few` when
 * the pairs are fewer than three or in a line: what they make of it is rough, and `need` says what a fit lacks.
 * Null with nothing in hand to apply.
 */
export interface Proposal { made: NewAlignment; fit?: PairFit; few?: boolean; need?: string }
export function proposed(state: Pick<AlignState, 'mode' | 'pairs' | 'scale' | 'floor' | 'onto' | 'height' | 'flip'>, current: ScanAlignment | null): Proposal | null {
  if (state.mode === 'floor') return state.floor ? { made: floorAlignment(current, state.floor, state.onto, state.height, state.flip) } : null
  if (state.mode !== 'pairs') return null
  const whole = wholeOf(state.pairs)
  const fit = fitOf(state.pairs, state.scale)
  if (fit && !('error' in fit)) return { made: pairsAlignment(state.pairs, fit), fit }
  const few = fitFew(whole.map((pair) => pair.scan), whole.map((pair) => pair.model), current?.transform ?? IDENTITY)
  if (!few) return null
  const need = fit ? fit.error : `${whole.length} of 3 pairs: with fewer, how the scan is turned is not fixed`
  return { made: fewAlignment(current, state.pairs, few), fit: few, few: true, need }
}

/** Where the scan is drawn for now while the tool is in hand: where main was asked to keep it, where a question that waits or a fit of three pairs would put it, where the floor in hand lays it. Null for where main has it. */
export function previewOf(state: AlignState, current: ScanAlignment | null): ScanTransform | null {
  if (state.sending) return state.sending.transform
  if (state.asking) return state.asking.made.transform
  const proposal = proposed(state, current)
  return proposal && !proposal.few ? proposal.made.transform : null
}

/** A plane, a direction or a point found on the scan as it is drawn (`drawn`), as it is where main has the scan (`kept`). */
export function asKept(drawn: ScanTransform, kept: ScanTransform): { point(p: Vec3): Vec3; direction(d: Vec3): Vec3 } {
  const back = compose(kept, inverse(drawn))
  return { point: (p) => apply(back, p), direction: (d) => rotate(back.q, d) }
}

/**
 * One step back, for Escape: what the store is to hold instead, or null when nothing is in hand. A question
 * that waits is withdrawn; then the last end of the pairs, the last of the points for a floor, the face that
 * was waited for, the floor.
 */
export function stepBack(state: AlignState): Partial<AlignState> | null {
  if (state.asking) return { asking: null }
  if (state.choosingFace) return { choosingFace: false }
  if (state.mode === 'pairs' && state.pairs.length > 0) return { pairs: withoutLastEnd(state.pairs) }
  if (state.mode === 'floor' && state.points.length > 0) return { points: state.points.slice(0, -1) }
  if (state.mode === 'floor' && state.floor) return { floor: null, onto: null, flip: false }
  if (state.refused) return { refused: null }
  return null
}

/** The pairs without the end that was given last: the model end of the last pair that has both or only that, else its scan end. */
export function withoutLastEnd(pairs: PairDraft[]): PairDraft[] {
  const last = pairs[pairs.length - 1]
  if (!last) return pairs
  const rest = pairs.slice(0, -1)
  // A pair is begun from either end: with both, the model's is taken to be the later, as the bar asks for them.
  return last.scan !== undefined && last.model !== undefined ? [...rest, { scan: last.scan }] : rest
}

/**
 * The one short line that says what to do next. `moved` are the parts of the layout torno moved for display;
 * `current` is the alignment main has.
 */
export function nextLine(state: AlignState, scan: ScanInfo | null, scans: number, current: ScanAlignment | null): string {
  if (!scan) return scans === 0 ? 'Import a scan first' : 'Choose the scan to align'
  if (state.asking) return 'Keep it as a rough alignment, or go on'
  if (state.mode === 'nudge') return 'Drag the handles or type values. Click the scan to hold it there'
  if (state.mode === 'floor') {
    if (state.choosingFace) return 'Click a flat face of the model to lay the floor on'
    if (!state.floor) return state.points.length > 0 ? `Shift-click ${3 - state.points.length} more on the floor` : 'Click the floor of the scan'
    return 'Apply lays this patch down. A click elsewhere takes another patch'
  }
  const whole = wholeOf(state.pairs).length
  if (expects(state.pairs) === 'model') return 'Now the same point on the model, or type it'
  if (whole === 0) return 'Click a point on the scan'
  if (proposed(state, current)?.few) return whole < 3 ? `Click another point on the scan: ${whole} of 3 pairs` : 'Click a point on the scan that is well off the line of the others'
  return 'Apply, or click another point on the scan to tighten the fit'
}

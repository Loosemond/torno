import { hint, pressed, which } from '../../shared/keys'
import { apply, compose, fitPlane, fitPlaneTrimmed, inverse, nudged, reckoned } from '../../shared/align'
import { number } from '../../shared/format'
import type { Quat, Vec3 } from '../../shared/marks'
import { type NewAlignment, type ScanAlignment, type ScanInfo, type ScanTransform, type ScanUnit, IDENTITY, MAX_PAIRS, UNIT_MM, alignmentOf } from '../../shared/scans'
import { type AlignState, alignStore, asKept, dropDraft, expects, hasDraft, movedAlignment, previewOf, scanInHand, setAlignScan, stepBack, withModelEnd, withScanEnd, withoutLastEnd } from '../state/align'
import { store } from '../state/store'
import { toolStore } from '../state/tools'
import type { AlignPoint } from '../viewport/alignPoints'
import type { Hit } from '../viewport/picking'
import { type ScanHit, meshOf } from '../viewport/scans'
import type { Viewport, ViewportPointer } from '../viewport/Viewport'
import { eulerOf, quatOf } from './shapeTool'
import { DESCRIBE_WITHIN_MS, dot, within, type Tool, type ToolContext } from './Tool'

/** Said at the pointer when there is nothing to align, or no telling which. */
export const NO_SCAN = 'Import a scan first'
export const CHOOSE_SCAN = 'Choose the scan to align, in the bar'
/** Said of a face the floor cannot be laid on. */
export const FLAT_FACE = 'Click a flat face'
export const NOT_SAID_FLAT = 'The kernel has not said that face is flat: click it again'
export const NO_DIRECTION = 'The kernel gave that face no direction: click another'
/** Said at the pointer when a click would begin one pair more than an alignment keeps. */
export const FULL = `${MAX_PAIRS} pairs is the most an alignment keeps`
export const NO_PATCH = 'No flat patch here: click a flatter part of the scan'
/** Said of a part torno set beside the others for display: where it is drawn is not where the model has it. */
export function movedPart(part: string): string {
  return `torno moved ${part} for display here: align to a part it did not move, or in a layout that places the parts as assembled`
}

/** The patch a click takes for the floor reaches this share of the scan's diagonal round it; `[` and `]` change it by a quarter. */
const PATCH_OF_DIAGONAL = 0.03
const PATCH_STEP = 0.25

/** The scan in hand, its alignment in the layout shown, and what an alignment made now is of. Null with no object, or no scan to work on. */
export function inHand(): { scan: ScanInfo; current: ScanAlignment | null; objectId: string; layout: string; revision: number } | null {
  const { objectId, layout, revision, scans } = store.getState()
  const scan = scanInHand(alignStore.getState().scan, scans)
  return objectId && scan ? { scan, current: alignmentOf(scan, layout), objectId, layout, revision } : null
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Has main keep an alignment of the scan in hand, in the layout shown, as made on the build on show. One that
 * whose fit of pairs is rough is first asked about (`alignStore.asking`), unless the person has said yes (`yes`)
 * or it is one already kept as rough being moved by hand again. A floor alone, or a scan placed by hand, is
 * kept as what it is, with no question. A scale is said to be chosen only when it was. While main
 * has not answered the scan is drawn where it was asked to be (`sending`); what main refuses is said (`refused`).
 */
export async function keepAlignment(made: NewAlignment, yes = false): Promise<void> {
  const hand = inHand()
  if (!hand) return
  const { scan, current, objectId, layout, revision } = hand
  const last = made.steps[made.steps.length - 1]
  const byHand = last === 'nudge' || last === 'typed'
  // As main will reckon it: a fit moved by hand is judged by how well it was fitted, which only main says (`fitRms`).
  const worth = reckoned({ ...made, ...(byHand && current?.fitRms !== undefined ? { fitRms: current.fitRms } : {}) })
  const byHandAgain = byHand && current?.rough !== undefined
  if (worth.rough !== undefined && !yes && !byHandAgain) {
    alignStore.setState({ asking: { made, why: worth.rough }, refused: null })
    return
  }
  const scaled = worth.scaled === true && (alignStore.getState().scale || current?.scaled === true)
  alignStore.setState({ sending: made, asking: null, refused: null })
  try {
    await window.torno.scans.align(objectId, scan.id, layout, made, { revision, rough: worth.rough !== undefined, scaled })
    // What was in hand went into it.
    dropDraft()
  } catch (e) {
    alignStore.setState({ sending: null, refused: messageOf(e), again: alignStore.getState().again + 1 })
  }
}

/** The person does not keep what was asked about: the scan is where main has it again. */
export function declineRough(): void {
  alignStore.setState({ asking: null, again: alignStore.getState().again + 1 })
}

/** Puts back the alignment the scan in hand had in the layout shown before the last one. */
export async function undoAlignment(): Promise<void> {
  const hand = inHand()
  if (!hand) return
  dropDraft()
  await window.torno.scans.undoAlign(hand.objectId, hand.scan.id, hand.layout).catch((e: unknown) => alignStore.setState({ refused: messageOf(e) }))
}

/** The scan in hand is aligned to nothing in the layout shown any more. */
export async function clearAlignment(): Promise<void> {
  const hand = inHand()
  if (!hand) return
  dropDraft()
  await window.torno.scans.align(hand.objectId, hand.scan.id, hand.layout, null).catch((e: unknown) => alignStore.setState({ refused: messageOf(e) }))
}

/**
 * Has the scan in hand read as being in another unit: what the bar offers when a fit says the unit is wrong.
 * One click while the scan is aligned in no layout. Changing the unit drops every alignment it has: with any,
 * nothing is done until the person has said yes (`yes`), and the layouts that would lose theirs are answered,
 * for the question. True once it is done, false when main refused (said in `refused`).
 *
 * The scan ends in hand are of the scan's own frame, which the change stretches about its origin: they are
 * stretched with it, so the pairs stand.
 */
export async function readAs(unit: ScanUnit, yes = false): Promise<boolean | string[]> {
  const hand = inHand()
  if (!hand) return false
  const { scan, objectId } = hand
  const aligned = Object.keys(scan.alignments)
  if (aligned.length > 0 && !yes) {
    // Asked in the bar, of this scan: the question goes when another scan is taken in hand.
    alignStore.setState({ unitAsked: { unit, layouts: aligned } })
    return aligned
  }
  alignStore.setState({ unitAsked: null })
  const factor = UNIT_MM[unit] / UNIT_MM[scan.imported.unit]
  const { pairs, pivot } = alignStore.getState()
  const stretched = (p: Vec3): Vec3 => [p[0] * factor, p[1] * factor, p[2] * factor]
  try {
    converting = scan.id
    await window.torno.scans.convert(objectId, scan.id, { unit, up: scan.imported.up })
    alignStore.setState({ pairs: pairs.map((pair) => (pair.scan ? { ...pair, scan: stretched(pair.scan) } : pair)), pivot: pivot && stretched(pivot), floor: null, points: [], scale: false, refused: null })
    return true
  } catch (e) {
    alignStore.setState({ refused: messageOf(e) })
    return false
  } finally {
    converting = null
  }
}

/**
 * The three angles of a scan (degrees about X, then Y, then Z) with one of them typed. The other two are as
 * they are, in full, not as their fields show them: `typed` while those three are still the turn the scan has
 * (many triples are one turn, and the one being typed is the one kept), else worked out from the turn.
 */
export function anglesWith(typed: Vec3 | null, q: Quat, index: number, degrees: number): Vec3 {
  const same = typed !== null && Math.abs(quatOf(typed).reduce((sum, c, i) => sum + c * q[i], 0)) > 1 - 1e-9
  return (same ? typed : eulerOf(q)).map((angle, i) => (i === index ? degrees : angle)) as Vec3
}

/** The scan `readAs` is converting: its mesh is another when that is done, and what is in hand is brought along rather than put down. */
let converting: string | null = null

/** Where the scan is drawn while the tool is in hand, and where main has it. */
function standing(state: AlignState, current: ScanAlignment | null): { drawn: ScanTransform; kept: ScanTransform } {
  const kept = current?.transform ?? IDENTITY
  return { drawn: previewOf(state, current) ?? kept, kept }
}

/** Said at the pointer over a part while a pair is asked for its scan end, and of a click there: it is kept as no end. */
export const WANTS_SCAN = `That is the model: click the scan, or press ${hint('align.first')} to give the model end first`
/** And over the scan, away from every part, while a pair is asked for its model end. */
export const WANTS_MODEL = 'That is the scan: click the same point on the model, or type it'

/**
 * The Align tool: stands a scan where the model is, in the layout shown. It works on one scan (`scanInHand`),
 * in one of three ways (`alignStore.mode`).
 *
 * - By the floor: the pointer tints the patch of the scan a click would take; a click fits a plane to it, and
 *   three clicks with Shift lay the plane through those three points. With a face waited for, a click on a
 *   flat face of a part chooses what the floor is laid on.
 * - By pairs: each pair is asked for one end, then the other (`expects`): a click gives the end that is asked
 *   for and no other. Tab switches which end a new pair is asked for first.
 * - By hand: the gizmo is on the scan (`connectAlign`), and a click on the scan moves the handles there.
 *
 * Nothing is kept by a click: what is in hand is a draft, drawn as a preview, until "Apply" in the bar.
 * A pointer move changes only what the viewport draws and the line at the pointer. Escape steps back one pick.
 */
export function alignTool(): Tool {
  /** How large the floor's patch is, against `PATCH_OF_DIAGONAL` of the scan. */
  let patch = 1
  /** Counts the clicks on a face and every time waiting for one is given up: the kernel's word on an earlier one is not taken. */
  let asked = 0

  const radiusOf = (scan: ScanInfo, standing: ScanTransform): number => {
    const { min, max } = scan.imported.bbox
    return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * standing.s * PATCH_OF_DIAGONAL * patch
  }
  const untint = (ctx: ToolContext): void => void ctx.viewport.scanPatch(null, 0)
  const quiet = (ctx: ToolContext): void => {
    ctx.viewport.setHover(null)
    ctx.readout.hide()
  }

  const chooseFace = async (face: Hit, ctx: ToolContext, client: [number, number]): Promise<void> => {
    if (ctx.moved?.(face.part)) return ctx.readout.say(client, movedPart(face.part))
    const { objectId, layout, revision } = ctx
    const mine = ++asked
    const said = await within(ctx.describe(face.ref), DESCRIBE_WITHIN_MS)
    const now = store.getState()
    if (mine !== asked || now.objectId !== objectId || now.layout !== layout || now.revision !== revision || !alignStore.getState().choosingFace) return
    // Only the kernel knows a face is flat, and where and how it lies.
    if (said?.kind !== 'face') return ctx.readout.say(client, NOT_SAID_FLAT)
    if (said.type !== 'plane' || !said.normal) return ctx.readout.say(client, FLAT_FACE)
    if (!(Math.hypot(...said.normal) > 1e-9)) return ctx.readout.say(client, NO_DIRECTION)
    const normal = face.normal && dot(said.normal, face.normal) < 0 ? (said.normal.map((c) => -c + 0) as Vec3) : said.normal
    // How the kernel says the face lies, at the point that was clicked: that is on the face, which the middle
    // of a face with a hole in it, or of an L, is not; and it is what later builds are asked about.
    alignStore.setState({ choosingFace: false, onto: { origin: face.point, normal, part: face.part }, refused: null })
    quiet(ctx)
  }

  const floor = (e: ViewportPointer, ctx: ToolContext, scan: ScanInfo, on: ScanHit | null, state: AlignState, current: ScanAlignment | null): void => {
    const click = e.type === 'click'
    if (state.choosingFace) {
      const face = e.hit?.kind === 'face' ? e.hit : click ? ctx.viewport.pick(e.client[0], e.client[1], { edges: false, partsOnly: true }) : null
      if (click) return void (face ? chooseFace(face, ctx, e.client) : ctx.readout.say(e.client, FLAT_FACE))
      ctx.viewport.setHover(face)
      if (face) ctx.readout.show(e.client, face.ref, ctx.descriptor(face.ref))
      else ctx.readout.hide()
      return
    }
    const { drawn, kept } = standing(state, current)
    const radius = radiusOf(scan, drawn)
    if (!click) {
      // The patch in hand stays tinted: the pointer shows another only while there is none.
      if (!state.floor && state.points.length === 0) ctx.viewport.scanPatch(on, radius, { tint: true })
      if (on && !state.floor) ctx.readout.say(e.client, `${scan.id}: a patch ${number(2 * radius)} mm across`)
      else ctx.readout.hide()
      return
    }
    if (!on) return
    // What was found on the scan as it is drawn (a floor in hand is previewed) is said as it is where main has the scan.
    const as = asKept(drawn, kept)
    if (e.shift) {
      const points = [...state.points, as.point(on.point)]
      if (points.length < 3) return alignStore.setState({ points, floor: null, refused: null })
      const plane = fitPlane(points)
      untint(ctx)
      if (!plane) return alignStore.setState({ points: points.slice(0, 2), refused: 'Those three points are in a line: click one that is off it' })
      return alignStore.setState({ points: [], floor: { plane: { ...plane, used: 3 }, facing: as.direction(on.normal), of: 3 }, refused: null })
    }
    const found = ctx.viewport.scanPatch(on, radius, { tint: true })
    const plane = found && fitPlaneTrimmed(found.points, found.weights)
    if (!found || !plane) return ctx.readout.say(e.client, NO_PATCH)
    alignStore.setState({ points: [], floor: { plane: { origin: as.point(plane.origin), normal: as.direction(plane.normal), rms: plane.rms * (kept.s / drawn.s), used: plane.used }, facing: as.direction(on.normal), of: found.points.length }, refused: null })
    ctx.readout.hide()
  }

  const pairs = (e: ViewportPointer, ctx: ToolContext, scan: ScanInfo, on: ScanHit | null, state: AlignState): void => {
    const click = e.type === 'click'
    // A click asks for the part whatever is in front: the scan may lie on it by now. A move takes what the viewport already found.
    const asks = expects(state.pairs, state.first)
    // And so does a move that is over the scan while the model end is asked for: behind a solid scan the viewport found no part,
    // and a click there would. What is said is what a click will do.
    const part = click || (asks === 'model' && on && !e.hit) ? ctx.viewport.pick(e.client[0], e.client[1], { partsOnly: true }) : e.hit
    // The end that is asked for is the only one a click gives, whatever is nearer: with the part sitting in the
    // scan, a click meant for the one lands on the other all the time, and would join the ends of two pairs.
    const asked = asks
    const which = asked === 'scan' ? (on ? 'scan' : null) : part ? 'model' : null
    const other = which === null && (asked === 'scan' ? part : on) ? (asked === 'scan' ? WANTS_SCAN : WANTS_MODEL) : null
    if (!click) {
      ctx.viewport.setHover(which === 'model' ? part : null)
      if (which === 'model' && part) ctx.readout.show(e.client, part.ref, ctx.descriptor(part.ref))
      else if (which === 'scan') ctx.readout.say(e.client, `${scan.id}: a point of the scan`)
      else if (other) ctx.readout.say(e.client, other)
      else ctx.readout.hide()
      return
    }
    if (other) return ctx.readout.say(e.client, other)
    if (which === null) return
    if (which === 'model' && part && ctx.moved?.(part.part)) return ctx.readout.say(e.client, movedPart(part.part))
    const pairs = which === 'scan' && on ? withScanEnd(state.pairs, on.local) : part ? withModelEnd(state.pairs, part.point, part.part) : state.pairs
    // No room for one pair more: said, not dropped in silence.
    if (pairs === state.pairs) return ctx.readout.say(e.client, FULL)
    alignStore.setState({ pairs, refused: null })
  }

  return {
    id: 'align',
    cursor: 'crosshair',
    onPointer(e: ViewportPointer, ctx: ToolContext) {
      const scans = store.getState().scans
      const state = alignStore.getState()
      const scan = scanInHand(state.scan, scans)
      if (e.type === 'cancel') {
        if (!state.floor) untint(ctx)
        return quiet(ctx)
      }
      if (e.type !== 'move' && e.type !== 'click') return
      // While a button is held the camera is being turned.
      if (e.type === 'move' && e.buttons !== 0) return
      if (!scan) return ctx.readout.say(e.client, scans.length === 0 ? NO_SCAN : CHOOSE_SCAN)
      // Nothing more is taken while an alignment waits for a yes, or for main.
      if (state.asking || state.sending) return ctx.readout.hide()
      const hit = ctx.viewport.pickScan(e.client[0], e.client[1])
      const on = hit?.scan === scan.id ? hit : null
      if (state.mode === 'floor') return floor(e, ctx, scan, on, state, alignmentOf(scan, ctx.layout))
      if (state.mode === 'pairs') return pairs(e, ctx, scan, on, state)
      // By hand: the handles go to the point of the scan that is clicked.
      if (e.type === 'click' && on) alignStore.setState({ pivot: on.local })
      ctx.readout.hide()
    },
    onKey(e: KeyboardEvent, ctx: ToolContext) {
      const state = alignStore.getState()
      // Which end of a new pair is given first: the model's, for whoever would rather click it before the scan.
      // Not on a button or a link: there Tab goes on to the next, as everywhere.
      const onControl = typeof (e.target as Element | null)?.closest === 'function' && (e.target as Element).closest('button, a, [role="button"]') !== null
      if (pressed(e, 'align.first') && state.mode === 'pairs' && !onControl) {
        if (!state.asking && !state.sending) alignStore.setState({ first: state.first === 'scan' ? 'model' : 'scan' })
        quiet(ctx)
        return true
      }
      const back = pressed(e, 'align.back')
      if (pressed(e, 'escape') || (back && state.mode === 'pairs' && !state.asking)) {
        const step = back ? (state.pairs.length > 0 ? { pairs: withoutLastEnd(state.pairs) } : null) : stepBack(state)
        if (!step) return back
        asked += 1
        if (step.asking === null && state.asking) declineRough()
        else alignStore.setState(step)
        if (!alignStore.getState().floor) untint(ctx)
        quiet(ctx)
        return true
      }
      const size = which(e, 'align.patch')
      if (state.mode === 'floor' && size >= 0) {
        patch = Math.min(Math.max(patch * (size === 1 ? 1 + PATCH_STEP : 1 - PATCH_STEP), 0.1), 10)
        const hand = inHand()
        const at = ctx.viewport.pointerAt?.()
        if (hand && at && !state.floor && state.points.length === 0) {
          const hit = ctx.viewport.pickScan(at[0], at[1])
          ctx.viewport.scanPatch(hit?.scan === hand.scan.id ? hit : null, radiusOf(hand.scan, standing(state, hand.current).drawn), { tint: true })
        }
        return true
      }
      const handle = which(e, 'align.handle')
      if (state.mode === 'nudge' && (handle >= 0 || pressed(e, 'align.size'))) {
        // A scan is moved and turned, never sized: T is taken, and does nothing.
        if (handle >= 0) alignStore.setState({ handle: handle === 0 ? 'translate' : 'rotate' })
        return true
      }
      return false
    },
    cancel(ctx: ToolContext) {
      asked += 1
      untint(ctx)
      quiet(ctx)
    }
  }
}

const centreOf = (scan: ScanInfo): Vec3 => scan.imported.bbox.min.map((low, axis) => (low + scan.imported.bbox.max[axis]) / 2) as Vec3

/**
 * Draws what the Align tool has in hand, while it is the tool in hand: the scan where the draft would put it,
 * the ends of the pairs as numbered dots, and, by hand, the gizmo on the scan, whose every drag let go is an
 * alignment asked of main. What is in hand was pointed at in one object, layout and build: it is put down
 * when any of them changes, and with the tool. Returns what undoes it.
 */
export function connectAlign(viewport: Pick<Viewport, 'previewScan' | 'showAlignPoints' | 'editScan'>): () => void {
  /** What the viewport was last asked for, so that it is asked only for what changed. */
  let previewed: { id: string; key: string } | null = null
  let dotted = '[]'
  let held: string | null = null

  const clear = (): void => {
    if (previewed) viewport.previewScan(previewed.id, null)
    previewed = null
    if (dotted !== '[]') viewport.showAlignPoints([])
    dotted = '[]'
    if (held !== null) viewport.editScan(null, 'translate', [0, 0, 0], () => {})
    held = null
  }

  const refresh = (): void => {
    const s = store.getState()
    const state = alignStore.getState()
    const scan = toolStore.getState().tool === 'align' && s.scene ? scanInHand(state.scan, s.scans) : null
    if (!scan) return clear()
    const current = alignmentOf(scan, s.layout)
    const { drawn, kept } = standing(state, current)
    const preview = previewOf(state, current)

    const key = JSON.stringify(preview)
    if (previewed && previewed.id !== scan.id) viewport.previewScan(previewed.id, null)
    if (previewed?.id !== scan.id || previewed.key !== key) viewport.previewScan(scan.id, preview)
    previewed = { id: scan.id, key }

    // The points of a floor are kept as they are where main has the scan: drawn where the scan is drawn.
    const shown = compose(drawn, inverse(kept))
    const points: AlignPoint[] = [
      ...state.pairs.flatMap((pair, n): AlignPoint[] => [...(pair.scan ? [{ at: apply(drawn, pair.scan), label: String(n + 1) }] : []), ...(pair.model ? [{ at: pair.model, label: String(n + 1), hollow: true }] : [])]),
      ...state.points.map((point): AlignPoint => ({ at: apply(shown, point), label: '' }))
    ]
    const dots = JSON.stringify(points)
    if (dots !== dotted) viewport.showAlignPoints(points)
    dotted = dots

    if (state.mode !== 'nudge') {
      if (held !== null) viewport.editScan(null, 'translate', [0, 0, 0], () => {})
      held = null
      return
    }
    // Held as it is while an alignment waits for a yes or for main: the scan is drawn where the drag left it.
    if (state.asking || state.sending) return
    const pivot = apply(kept, state.pivot ?? centreOf(scan))
    const holding = JSON.stringify([scan.id, state.handle, pivot, kept, state.again])
    if (holding === held) return
    held = holding
    // Added to the alignment there is when the drag is let go, which may say more by then than when the handles were put on.
    viewport.editScan(scan.id, state.handle, pivot, ({ move, turn }: { move: Vec3; turn: Quat }) => void keepAlignment(movedAlignment(inHand()?.current ?? null, nudged(kept, pivot, move, turn), 'nudge')))
  }

  refresh()
  const offAlign = alignStore.subscribe(refresh)
  const offTool = toolStore.subscribe(refresh)
  const offStore = store.subscribe((s, prev) => {
    const state = alignStore.getState()
    const had = scanInHand(state.scan, prev.scans)
    const has = scanInHand(state.scan, s.scans)
    // Another object: nothing in hand is of it, whichever scan was or was not named, and no build of it "changed" what was picked.
    if (s.objectId !== prev.objectId) {
      setAlignScan(null)
      dropDraft()
    }
    // The scan that was named is gone: what was picked on it goes with it, and is not the next scan's.
    else if (state.scan !== null && !has) setAlignScan(null)
    // Another scan in hand, or another mesh of the same one (converted, read again): its points are elsewhere.
    else if (had && (!has || has.id !== had.id || (meshOf(has) !== meshOf(had) && converting !== has.id))) dropDraft()
    else if (s.layout !== prev.layout) dropDraft()
    // A build lands while the person is picking: what was pointed at was of the build before. Said, since the agent builds often.
    else if (s.revision !== prev.revision) dropDraft(hasDraft(state) ? `The build changed: pick the ${state.mode === 'floor' ? 'floor' : 'pairs'} again` : null)
    refresh()
  })
  return () => {
    offAlign()
    offTool()
    offStore()
    clear()
  }
}

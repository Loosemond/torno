import { apply, compose, fitPlane, fitPlaneTrimmed, inverse, nudged, reckoned } from '../../shared/align'
import { number } from '../../shared/format'
import type { Quat, Vec3 } from '../../shared/marks'
import { type NewAlignment, type ScanAlignment, type ScanInfo, type ScanTransform, type ScanUnit, IDENTITY, UNIT_MM, alignmentOf } from '../../shared/scans'
import { type AlignState, alignStore, asKept, dropDraft, expects, movedAlignment, previewOf, scanInHand, setAlignScan, stepBack, withModelEnd, withScanEnd, withoutLastEnd } from '../state/align'
import { store } from '../state/store'
import { toolStore } from '../state/tools'
import type { AlignPoint } from '../viewport/alignPoints'
import type { Hit } from '../viewport/picking'
import type { ScanHit } from '../viewport/scans'
import type { Viewport, ViewportPointer } from '../viewport/Viewport'
import { DESCRIBE_WITHIN_MS, dot, within, type Tool, type ToolContext } from './Tool'

/** Said at the pointer when there is nothing to align, or no telling which. */
export const NO_SCAN = 'Import a scan first'
export const CHOOSE_SCAN = 'Choose the scan to align, in the bar'
/** Said of a face the floor cannot be laid on. */
export const FLAT_FACE = 'Click a flat face'
export const NOT_SAID_FLAT = 'The kernel has not said that face is flat: click it again'
export const NO_PATCH = 'No flat patch here: click a flatter part of the scan'
/** Said of a part torno set beside the others for display: where it is drawn is not where the model has it. */
export function movedPart(part: string): string {
  return `torno moved ${part} for display here: align to a part it did not move, or in a layout that places the parts as assembled`
}

/** The patch a click takes for the floor reaches this share of the scan's diagonal round it; `[` and `]` change it by a quarter. */
const PATCH_OF_DIAGONAL = 0.03
const PATCH_STEP = 0.25
/** A scan and a part this near one another along the ray lie in one surface: which is clicked is then what is asked for next. */
const SAME_SURFACE_MM = 0.5

/** The scan in hand, its alignment in the layout shown, and what an alignment made now is of. Null with no object, or no scan to work on. */
export function inHand(): { scan: ScanInfo; current: ScanAlignment | null; objectId: string; layout: string; revision: number } | null {
  const { objectId, layout, revision, scans } = store.getState()
  const scan = scanInHand(alignStore.getState().scan, scans)
  return objectId && scan ? { scan, current: alignmentOf(scan, layout), objectId, layout, revision } : null
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Has main keep an alignment of the scan in hand, in the layout shown, as made on the build on show. One that
 * is rough is first asked about (`alignStore.asking`), unless the person has said yes (`yes`) or it is a scan
 * already kept as rough being moved by hand again. A scale is said to be chosen only when it was. While main
 * has not answered the scan is drawn where it was asked to be (`sending`); what main refuses is said (`refused`).
 */
export async function keepAlignment(made: NewAlignment, yes = false): Promise<void> {
  const hand = inHand()
  if (!hand) return
  const { scan, current, objectId, layout, revision } = hand
  const worth = reckoned(made)
  const last = made.steps[made.steps.length - 1]
  const byHandAgain = (last === 'nudge' || last === 'typed') && current?.rough !== undefined
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
 * Has the scan in hand read as being in another unit: the one click the bar offers when a fit says the unit is
 * wrong. Its alignments are dropped by main, as from its row. The scan ends in hand are of the scan's own
 * frame, which the change stretches about its origin: they are stretched with it, so the pairs stand.
 */
export async function readAs(unit: ScanUnit): Promise<void> {
  const hand = inHand()
  if (!hand) return
  const { scan, objectId } = hand
  const factor = UNIT_MM[unit] / UNIT_MM[scan.imported.unit]
  try {
    await window.torno.scans.convert(objectId, scan.id, { unit, up: scan.imported.up })
    const { pairs, pivot } = alignStore.getState()
    const stretched = (p: Vec3): Vec3 => [p[0] * factor, p[1] * factor, p[2] * factor]
    alignStore.setState({ pairs: pairs.map((pair) => (pair.scan ? { ...pair, scan: stretched(pair.scan) } : pair)), pivot: pivot && stretched(pivot), floor: null, points: [], scale: false, refused: null })
  } catch (e) {
    alignStore.setState({ refused: messageOf(e) })
  }
}

/** Where the scan is drawn while the tool is in hand, and where main has it. */
function standing(state: AlignState, current: ScanAlignment | null): { drawn: ScanTransform; kept: ScanTransform } {
  const kept = current?.transform ?? IDENTITY
  return { drawn: previewOf(state, current) ?? kept, kept }
}

/** Which of the two things under the pointer a click takes: the nearer, or, where they lie in one surface, the one that is asked for next. */
function underPointer(scan: ScanHit | null, part: Hit | null, asked: 'scan' | 'model'): 'scan' | 'model' | null {
  if (!scan || !part) return scan ? 'scan' : part ? 'model' : null
  if (Math.abs(scan.distance - part.distance) <= SAME_SURFACE_MM) return asked
  return scan.distance < part.distance ? 'scan' : 'model'
}

/**
 * The Align tool: stands a scan where the model is, in the layout shown. It works on one scan (`scanInHand`),
 * in one of three ways (`alignStore.mode`).
 *
 * - By the floor: the pointer tints the patch of the scan a click would take; a click fits a plane to it, and
 *   three clicks with Shift lay the plane through those three points. With a face waited for, a click on a
 *   flat face of a part chooses what the floor is laid on.
 * - By pairs: a click on the scan is a point of the scan, a click on a part where that point belongs.
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
  const untint = (ctx: ToolContext): void => void ctx.viewport.scanPatch?.(null, 0)
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
    const normal = face.normal && dot(said.normal, face.normal) < 0 ? (said.normal.map((c) => -c + 0) as Vec3) : said.normal
    alignStore.setState({ choosingFace: false, onto: { origin: said.center, normal, part: face.part }, refused: null })
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
      if (!state.floor && state.points.length === 0) ctx.viewport.scanPatch?.(on, radius, { tint: true })
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
    const found = ctx.viewport.scanPatch?.(on, radius, { tint: true })
    const plane = found && fitPlaneTrimmed(found.points, found.weights)
    if (!found || !plane) return ctx.readout.say(e.client, NO_PATCH)
    alignStore.setState({ points: [], floor: { plane: { origin: as.point(plane.origin), normal: as.direction(plane.normal), rms: plane.rms * (kept.s / drawn.s), used: plane.used }, facing: as.direction(on.normal), of: found.points.length }, refused: null })
    ctx.readout.hide()
  }

  const pairs = (e: ViewportPointer, ctx: ToolContext, scan: ScanInfo, on: ScanHit | null, state: AlignState): void => {
    const click = e.type === 'click'
    // A click asks for the part whatever is in front: the scan may lie on it by now. A move takes what the viewport already found.
    const part = click ? ctx.viewport.pick(e.client[0], e.client[1], { partsOnly: true }) : e.hit
    const which = underPointer(on, part, expects(state.pairs))
    if (!click) {
      ctx.viewport.setHover(which === 'model' ? part : null)
      if (which === 'model' && part) ctx.readout.show(e.client, part.ref, ctx.descriptor(part.ref))
      else if (which === 'scan') ctx.readout.say(e.client, `${scan.id}: a point of the scan`)
      else ctx.readout.hide()
      return
    }
    if (which === 'scan' && on) return alignStore.setState({ pairs: withScanEnd(state.pairs, on.local), refused: null })
    if (which !== 'model' || !part) return
    if (ctx.moved?.(part.part)) return ctx.readout.say(e.client, movedPart(part.part))
    alignStore.setState({ pairs: withModelEnd(state.pairs, part.point, part.part), refused: null })
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
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (key === 'Escape' || (key === 'Backspace' && state.mode === 'pairs' && !state.asking)) {
        const step = key === 'Backspace' ? (state.pairs.length > 0 ? { pairs: withoutLastEnd(state.pairs) } : null) : stepBack(state)
        if (!step) return key === 'Backspace'
        asked += 1
        if (step.asking === null && state.asking) declineRough()
        else alignStore.setState(step)
        if (!alignStore.getState().floor) untint(ctx)
        quiet(ctx)
        return true
      }
      if (state.mode === 'floor' && (key === '[' || key === ']')) {
        patch = Math.min(Math.max(patch * (key === ']' ? 1 + PATCH_STEP : 1 - PATCH_STEP), 0.1), 10)
        const hand = inHand()
        const at = ctx.viewport.pointerAt?.()
        if (hand && at && !state.floor && state.points.length === 0) {
          const hit = ctx.viewport.pickScan(at[0], at[1])
          ctx.viewport.scanPatch?.(hit?.scan === hand.scan.id ? hit : null, radiusOf(hand.scan, standing(state, hand.current).drawn), { tint: true })
        }
        return true
      }
      if (state.mode === 'nudge' && (key === 'g' || key === 'r' || key === 't')) {
        // A scan is moved and turned, never sized: T is taken, and does nothing.
        if (key !== 't') alignStore.setState({ handle: key === 'g' ? 'translate' : 'rotate' })
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
    viewport.editScan(scan.id, state.handle, pivot, ({ move, turn }: { move: Vec3; turn: Quat }) => void keepAlignment(movedAlignment(current, nudged(kept, pivot, move, turn), 'nudge')))
  }

  refresh()
  const offAlign = alignStore.subscribe(refresh)
  const offTool = toolStore.subscribe(refresh)
  const offStore = store.subscribe((s, prev) => {
    if (s.objectId !== prev.objectId) setAlignScan(null)
    else if (s.layout !== prev.layout || s.revision !== prev.revision) dropDraft()
    refresh()
  })
  return () => {
    offAlign()
    offTool()
    offStore()
    clear()
  }
}

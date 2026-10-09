import * as THREE from 'three'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import type { BuiltPart } from './partMesh'
import { parseRef } from './picking'

/** What is pointed at, what is selected, and what the agent points at. */
export type HighlightLayer = 'hover' | 'selection' | 'agent'

const LAYERS: Record<HighlightLayer, { color: 'accent' | 'agent'; tint: number; line: number; order: number }> = {
  hover: { color: 'accent', tint: 0.26, line: 2.5, order: 3 },
  selection: { color: 'accent', tint: 0.42, line: 3.5, order: 2 },
  agent: { color: 'agent', tint: 0.45, line: 3.5, order: 1 }
}

interface Overlay {
  /** The part's own surface again, of which only the highlighted faces are drawn. */
  faces: THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>
  lines: LineSegments2 | null
}

interface LayerState {
  refs: string[]
  tint: THREE.MeshBasicMaterial
  line: LineMaterial
  overlays: Map<BuiltPart, Overlay>
}

/**
 * Faces tinted and edges thickened on the parts, by ref: `lid/F12`, `lid/E3`,
 * or `lid` for the whole part. The drawing hangs under each part's group, so
 * it moves and hides with the part. Refs are kept and resolved again with
 * `apply` whenever the parts change; one that names nothing draws nothing.
 */
export class Highlights {
  private readonly layers: Record<HighlightLayer, LayerState>
  private visible = true

  constructor() {
    const make = (name: HighlightLayer): LayerState => ({
      refs: [],
      tint: new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: LAYERS[name].tint,
        depthWrite: false,
        // In front of the surface it lies on (pushed back by 1), behind the edges drawn on that.
        polygonOffset: true,
        polygonOffsetFactor: 0.5,
        polygonOffsetUnits: 0.5
      }),
      line: new LineMaterial({ linewidth: LAYERS[name].line }),
      overlays: new Map()
    })
    this.layers = { hover: make('hover'), selection: make('selection'), agent: make('agent') }
  }

  setColors(colors: { accent: string; agent: string }): void {
    for (const name of Object.keys(this.layers) as HighlightLayer[]) {
      const color = colors[LAYERS[name].color]
      this.layers[name].tint.color.set(color)
      this.layers[name].line.color.set(color)
    }
  }

  /** What a layer highlights from now on. Returns false when that is what it already did. */
  set(layer: HighlightLayer, refs: string[]): boolean {
    const state = this.layers[layer]
    if (refs.length === state.refs.length && refs.every((ref, i) => ref === state.refs[i])) return false
    state.refs = [...refs]
    return true
  }

  /** Draws the layers anew. `partNamed` finds a part of the layout shown. */
  apply(partNamed: (name: string) => BuiltPart | undefined, only?: HighlightLayer): void {
    for (const name of only ? [only] : (Object.keys(this.layers) as HighlightLayer[])) this.applyLayer(name, partNamed)
  }

  /** Hides everything, for a picture that is of the parts alone. */
  setVisible(visible: boolean): void {
    this.visible = visible
    for (const state of Object.values(this.layers)) {
      for (const overlay of state.overlays.values()) {
        overlay.faces.visible = visible && overlay.faces.geometry.groups.length > 0
        if (overlay.lines) overlay.lines.visible = visible
      }
    }
  }

  /** A part is going: what was drawn on it goes first. Its own geometry is left for its owner to free. */
  forget(built: BuiltPart): void {
    for (const state of Object.values(this.layers)) {
      const overlay = state.overlays.get(built)
      if (!overlay) continue
      state.overlays.delete(built)
      built.group.remove(overlay.faces)
      this.dropLines(built, overlay)
      // Not disposed: the geometry shares its buffers with the part's, which is freed with the part.
    }
  }

  dispose(): void {
    for (const state of Object.values(this.layers)) {
      for (const built of [...state.overlays.keys()]) this.forget(built)
      state.tint.dispose()
      state.line.dispose()
    }
  }

  private applyLayer(name: HighlightLayer, partNamed: (name: string) => BuiltPart | undefined): void {
    const state = this.layers[name]
    for (const [built, overlay] of state.overlays) {
      overlay.faces.geometry.clearGroups()
      overlay.faces.visible = false
      this.dropLines(built, overlay)
    }

    const segments = new Map<BuiltPart, number[]>()
    for (const ref of state.refs) {
      const { part, kind, index } = parseRef(ref)
      const built = partNamed(part)
      if (!built) continue
      if (kind === 'edge') {
        const from = built.edgeStarts[index]
        const to = built.edgeStarts[index + 1]
        if (to === undefined || to <= from) continue
        const positions = built.edges.geometry.getAttribute('position').array
        const list = segments.get(built) ?? []
        for (let i = from * 6; i < to * 6; i++) list.push(positions[i])
        segments.set(built, list)
        continue
      }
      const starts = built.faceStarts
      const from = kind === 'part' ? 0 : starts[index]
      const to = kind === 'part' ? starts[starts.length - 1] : starts[index + 1]
      if (to === undefined || to <= from) continue
      const overlay = this.overlayFor(name, built)
      overlay.faces.geometry.addGroup(from, to - from, 0)
      overlay.faces.visible = this.visible
    }

    for (const [built, positions] of segments) {
      const overlay = this.overlayFor(name, built)
      const lines = new LineSegments2(new LineSegmentsGeometry().setPositions(positions), state.line)
      lines.renderOrder = LAYERS[name].order + 3
      lines.visible = this.visible
      overlay.lines = lines
      built.group.add(lines)
    }
  }

  private overlayFor(name: HighlightLayer, built: BuiltPart): Overlay {
    const state = this.layers[name]
    let overlay = state.overlays.get(built)
    if (!overlay) {
      const source = built.mesh.geometry
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', source.getAttribute('position'))
      geometry.setIndex(source.getIndex())
      geometry.boundingSphere = source.boundingSphere
      const faces = new THREE.Mesh(geometry, [state.tint])
      faces.renderOrder = LAYERS[name].order
      faces.visible = false
      faces.raycast = () => {} // never picked
      overlay = { faces, lines: null }
      state.overlays.set(built, overlay)
      built.group.add(faces)
    }
    return overlay
  }

  private dropLines(built: BuiltPart, overlay: Overlay): void {
    if (!overlay.lines) return
    built.group.remove(overlay.lines)
    overlay.lines.geometry.dispose()
    overlay.lines = null
  }
}

/** How far from the pointer the readout sits, in pixels. */
const READOUT_OFFSET = { x: 14, y: 18 }
const READOUT_MARGIN = 8

/**
 * The line of text that follows the pointer over the parts: a ref and, once
 * known, what the kernel says of it; or a sentence. One element, written to
 * directly on every move, so that nothing of a pointer move reaches React.
 */
export class Readout {
  private readonly host: HTMLElement
  private readonly element = document.createElement('div')
  private readonly ref = document.createElement('span')
  private readonly detail = document.createElement('span')

  constructor(host: HTMLElement) {
    this.host = host
    this.element.className = 'pick-readout'
    this.element.hidden = true
    this.ref.className = 'pick-readout-ref num'
    this.detail.className = 'pick-readout-detail num'
    this.element.append(this.ref, this.detail)
    host.append(this.element)
  }

  /** Shows a ref at the pointer, with what is known of it. */
  show(client: [number, number], ref: string, detail = ''): void {
    this.element.dataset.says = 'ref'
    this.write(ref, detail)
    this.place(client)
  }

  /** Adds, or replaces, what is said of the ref on show. */
  describe(detail: string): void {
    if (this.element.hidden) return
    this.write(this.ref.textContent ?? '', detail)
  }

  /** Shows a sentence at the pointer instead of a ref. */
  say(client: [number, number], message: string): void {
    this.element.dataset.says = 'sentence'
    this.write('', message)
    this.place(client)
  }

  hide(): void {
    this.element.hidden = true
  }

  dispose(): void {
    this.element.remove()
  }

  private write(ref: string, detail: string): void {
    if (this.ref.textContent !== ref) this.ref.textContent = ref
    if (this.detail.textContent !== detail) this.detail.textContent = detail
    this.ref.hidden = ref === ''
    this.detail.hidden = detail === ''
  }

  private place(client: [number, number]): void {
    this.element.hidden = false
    const box = this.host.getBoundingClientRect()
    const width = this.element.offsetWidth
    const height = this.element.offsetHeight
    let x = client[0] - box.left + READOUT_OFFSET.x
    let y = client[1] - box.top + READOUT_OFFSET.y
    // Kept inside the viewport: to the left of the pointer, or above it, where it would run out.
    if (x + width > box.width - READOUT_MARGIN) x = Math.max(READOUT_MARGIN, client[0] - box.left - READOUT_OFFSET.x - width)
    if (y + height > box.height - READOUT_MARGIN) y = Math.max(READOUT_MARGIN, client[1] - box.top - READOUT_OFFSET.y - height)
    this.element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  }
}

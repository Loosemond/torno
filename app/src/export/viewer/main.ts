import { themeOf } from '../../renderer/viewport/theme'
import { towardsViewer } from '../../shared/cut'
import { type ExplodeState, NO_EXPLODE, explodeOf, explodeOffsets, explodeShown, leavesView, neverBoth, nothingApart } from '../../shared/explode'
import { type ExportData, type ExportMark, type ExportObject, type ExportPart, type MeshArrays, apartParts, record, unpackMesh, unpackScan } from '../../shared/exportdata'
import type { Vec3 } from '../../shared/marks'
import { type Camera, type SectionPlane, type ViewName, axisForm, planeOf } from '../../shared/view'
import { Model, type ScanArraysOf } from './model'
import { type Label, createOverlay } from './overlay'
import { type Axis, type MarkRow, type PageState, type PanelHost, createPanel, dateOf } from './panel'

// The script of an exported page. It reads the data that is written in the page itself, unpacks the meshes of
// the object on show (each object's when it is first shown, not all at once) and draws them. It asks nothing of
// the network: the page's own policy would refuse it. It measures nothing: every value it shows was measured by
// torno, on the exact geometry of the build the file was made from, and is in the data as text.

interface Loaded { meshes: Map<string, MeshArrays>; scans: Array<{ scan: NonNullable<ExportObject['scans']>[number]; arrays: ScanArraysOf }> }

/** The page's test hook, always there: it costs nothing, and lets the file be checked wherever it is opened. */
export interface TornoExport {
  state(): {
    object: string
    layout: string
    parts: Array<{ name: string; visible: boolean; offset: Vec3 }>
    explode: ExplodeState
    section: SectionPlane | null
    marks: boolean
    resolved: boolean
    /** The marks whose labels are drawn. */
    labels: string[]
    /** As it is drawn, and what was chosen: the system's, or one by hand. */
    theme: 'light' | 'dark'
    themeChoice: Theme
    views: string[]
    view: string | null
    scans: Array<{ id: string; visible: boolean; opacity: number }>
    ortho: boolean
    camera: Camera
    /** Whether a part that is switched on is drawn out of the view. */
    leaves: boolean
  }
  /** Resolves once the object is unpacked and shown. */
  setObject(id: string): Promise<void>
  setLayout(name: string): void
  setPart(name: string, visible: boolean): void
  setExplode(amount: number, axis?: ExplodeState['axis']): void
  setSection(axis: Axis | null, t?: number): void
  applyView(name: string): boolean
  setMarks(on: boolean): void
  setResolved(on: boolean): void
  setTheme(theme: Theme): void
  /** The colour of the parts and scans drawn at a point of the canvas, in fractions of it: [r, g, b, a], on a frame drawn for the asking, without the grid and the marks. */
  pixel(fx: number, fy: number): [number, number, number, number]
  /** The colour of the ground. */
  ground(): [number, number, number]
  /** Why nothing of the parts is on the canvas, as the page would say it; null when something is. A frame is drawn for the asking. */
  undrawn(): string | null
}

/** The page in the system's theme, or in one chosen by hand. */
export type Theme = 'system' | 'light' | 'dark'

declare global {
  interface Window { __tornoExport?: TornoExport }
}

const UNPACK = 'This browser cannot unpack the parts: open the file in a current Chrome, Edge, Firefox or Safari'
const BROKE = 'This page could not start in this browser, so the parts are not shown. Open the file in a current Chrome, Edge, Firefox or Safari'
/** How long after the parts began to be unpacked the page looks whether anything of them is on the canvas. */
const WATCH_MS = 3000
/** Where to open the file instead, said after why the parts cannot be drawn here. */
const ELSEWHERE = 'Open the file in a current Chrome, Edge, Firefox or Safari, with hardware acceleration switched on.'
const NO_WEBGL = `This browser cannot draw the parts here: it gives the page no WebGL 2. ${ELSEWHERE}`

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64)
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes
}

async function inflate(base64: string): Promise<Uint8Array> {
  const stream = new Blob([bytesOf(base64)]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** In place of the page: it cannot be drawn, and says why. Nothing else is shown, no empty column of controls. */
function say(root: HTMLElement, text: string): void {
  root.dataset.bare = ''
  const message = document.createElement('p')
  message.className = 'message'
  message.setAttribute('role', 'alert')
  message.textContent = text
  root.append(message)
}

function start(): void {
  const root = document.getElementById('torno')!
  const canvas = document.getElementById('view') as HTMLCanvasElement
  const panelRoot = document.getElementById('panel')!
  let data: ExportData
  try {
    data = JSON.parse(document.getElementById('torno-data')!.textContent ?? '')
    if (data.format !== 'torno-export' || data.version !== 1 || !Array.isArray(data.objects) || data.objects.length === 0) throw new Error('not an export')
  } catch {
    return say(root, 'This file holds no parts that this page can read.')
  }
  if (typeof DecompressionStream === 'undefined') return say(root, UNPACK)

  const overlay = createOverlay(document.getElementById('overlay')!)
  let model: Model
  try {
    model = new Model(canvas, themeOf(), () => overlay.place((point, by) => model.project(point, by)))
  } catch {
    return say(root, NO_WEBGL)
  }

  const states = new Map<string, PageState>()
  const loaded = new Map<string, Promise<Loaded>>()
  let object = data.objects[0]
  let meshes: Loaded | null = null
  let busy = false
  let labels: string[] = []

  const stateOf = (one: ExportObject): PageState => {
    let state = states.get(one.id)
    if (!state) {
      const layout = one.layouts.includes(one.layout) ? one.layout : (one.layouts[0] ?? '')
      // By the names of parts, layouts and scans, which are anyone's to choose: records with no key but those.
      const visible = record<boolean>()
      for (const part of one.parts) visible[part.name] = part.visible
      const explode = record<ExplodeState>()
      for (const [name, kept] of Object.entries(one.explode ?? {})) {
        const sane = explodeOf(kept)
        if (sane) explode[name] = sane
      }
      const scans: PageState['scans'] = record()
      for (const scan of one.scans ?? []) scans[scan.id] = { visible: true, opacity: 1 }
      state = { layout, visible, explode, section: null, cut: null, marks: (one.marks ?? []).length > 0, resolved: false, scans, view: null }
      states.set(one.id, state)
    }
    return state
  }
  const state = (): PageState => stateOf(object)
  const parts = (): ExportPart[] => object.parts.filter((part) => part.layout === state().layout)
  /** The one rule for what is drawn apart, the app's own (`explodeShown`): never with a section, never of parts that would not move. */
  /** The parts the rule is asked of: those of the layout, and the boxes of those the file leaves out. As in the app, of every part, drawn or not. */
  const ruled = () => apartParts(object, state().layout)
  const apart = (): ExplodeState | null => explodeShown(state().explode[state().layout], state().section, ruled())
  const offsets = (): Record<string, Vec3> => explodeOffsets(ruled(), apart())
  const boxOf = (): { min: Vec3; max: Vec3 } => {
    const min: Vec3 = [Infinity, Infinity, Infinity]
    const max: Vec3 = [-Infinity, -Infinity, -Infinity]
    for (const part of parts()) for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], part.bbox.min[i])
      max[i] = Math.max(max[i], part.bbox.max[i])
    }
    return Number.isFinite(min[0]) ? { min, max } : { min: [0, 0, 0], max: [1, 1, 1] }
  }

  /** The marks of the layout on show, each with how it is drawn: moved with its part, or not at all. */
  const rows = (): Array<MarkRow & { by: Vec3 }> => {
    const moved = offsets()
    const visible = state().visible
    const still: Vec3 = [0, 0, 0]
    return (object.marks ?? [])
      .filter((mark) => mark.layout === state().layout)
      .map((mark) => {
        const on = mark.ends ? mark.ends.filter((part): part is string => part !== null) : mark.part !== undefined ? [mark.part] : []
        // A mark on a part that is not drawn is not drawn either.
        if (on.length > 0 && on.every((part) => visible[part] === false)) return { mark, drawn: false, why: 'its part is switched off', by: still }
        const ends = (mark.ends ?? [mark.part ?? null]).map((part) => (part !== null && moved[part]) || still)
        // Between parts that are drawn apart otherwise than one another it would span a gap that is no measure of anything.
        if (ends.some((end) => end.some((c, i) => Math.abs(c - ends[0][i]) > 1e-9))) return { mark, drawn: false, why: 'not drawn while its parts are apart', by: still }
        return { mark, drawn: true, by: ends[0] }
      })
  }

  /** Whether a part that is switched on, drawn apart, is out of the view: torno's own rule (`leavesView`). */
  const leaves = (): boolean => {
    const moved = offsets()
    if (Object.keys(moved).length === 0 || canvas.clientWidth === 0 || canvas.clientHeight === 0) return false
    const seen = (point: Vec3): [number, number] => {
      const at = model.project(point)
      return [(at.x / canvas.clientWidth) * 2 - 1, 1 - (at.y / canvas.clientHeight) * 2]
    }
    return leavesView(parts().filter((part) => state().visible[part.name] !== false), moved, seen)
  }
  /** After the parts were drawn apart otherwise, or a view applied: the camera stays, unless a part would be out of sight. */
  const keepInView = (): void => {
    if (leaves()) model.fit()
  }

  const said = document.createElement('p')
  said.id = 'said'
  said.setAttribute('role', 'status')
  root.append(said)

  /** What the page says in place of the parts when they are not on the canvas (`watch`); null while they are, or nobody looked. */
  let notDrawn: string | null = null
  let watching: ReturnType<typeof setTimeout> | undefined

  /**
   * A page that shows its controls and no parts, and says nothing, is the one thing this file must never be:
   * `WATCH_MS` after the parts began to be unpacked (and again while they still are), the canvas is looked at, and
   * if nothing of them is on it the page says so, and why as far as it can tell. Not while nothing is switched on,
   * nor under a cut, which may leave nothing by the person's own hand; not after an object that could not be shown,
   * which says so itself (`show`); and looked at again whenever an object is shown anew.
   */
  function watch(): void {
    clearTimeout(watching)
    watching = setTimeout(look, WATCH_MS)
  }

  // A context the browser takes away later (a driver that was reset) is looked at the same way, and so is one it
  // gives back: the page says what it is then.
  canvas.addEventListener('webglcontextlost', watch)
  canvas.addEventListener('webglcontextrestored', watch)

  function look(): void {
    if (busy) return watch()
    try {
      const st = state()
      const on = parts().some((part) => st.visible[part.name] !== false) || (object.scans ?? []).some((scan) => st.scans[scan.id]?.visible !== false)
      const why = on && !st.section ? model.undrawn() : null
      notDrawn = why === null ? null : `The parts cannot be drawn here: ${why}. ${ELSEWHERE}`
      refresh()
    } catch (e) {
      said.textContent = `The parts cannot be drawn here: ${e instanceof Error ? e.message : String(e)}. ${ELSEWHERE}`
      said.hidden = false
    }
  }

  function refresh(): void {
    const st = state()
    if (meshes) {
      model.apply({ visible: st.visible, offsets: offsets(), section: st.section, scans: st.scans })
      // A resolved mark is in the list; on the part it is drawn only when asked.
      const drawn = st.marks ? rows().filter((row) => row.drawn && (st.resolved || row.mark.status !== 'resolved')) : []
      labels = drawn.map((row) => row.mark.id)
      overlay.set(drawn.map((row): Label => ({ mark: row.mark, by: row.by, dimmed: model.cutAway(row.mark.at) })))
      // Where they were drawn last, until the frame that is on its way says better.
      overlay.place((point, by) => model.project(point, by))
    }
    const now = apart()
    said.textContent = busy ? 'Unpacking the parts…' : (notDrawn ?? (now ? 'Parts drawn apart for display' : st.section ? 'Cut open for display' : ''))
    said.hidden = said.textContent === ''
    panel.sync()
  }

  /** The parts of the layout on show, built anew: for another object or another layout. */
  function showLayout(view?: ViewName): void {
    if (!meshes) return
    model.setParts(parts(), meshes.meshes)
    model.setScans(meshes.scans, state().layout)
    panel.rebuild()
    refresh()
    model.fit(view)
  }

  function load(one: ExportObject): Promise<Loaded> {
    let made = loaded.get(one.id)
    if (!made) {
      made = (async () => {
        const unpacked = new Map<string, MeshArrays>()
        for (const [hash, packed] of Object.entries(one.meshes)) {
          const { data: base64, ...header } = packed
          unpacked.set(hash, unpackMesh(header, await inflate(base64)))
        }
        const scans: Loaded['scans'] = []
        for (const scan of one.scans ?? []) scans.push({ scan, arrays: unpackScan(scan, await inflate(scan.data)) })
        return { meshes: unpacked, scans }
      })()
      loaded.set(one.id, made)
    }
    return made
  }

  async function show(one: ExportObject, view?: ViewName): Promise<void> {
    busy = true
    panel.sync()
    said.textContent = 'Unpacking the parts…'
    said.hidden = false
    notDrawn = null
    watch()
    try {
      const got = await load(one)
      object = one
      meshes = got
      busy = false
      document.title = data.objects.length > 1 ? `${one.name} · ${data.title}` : data.title
      canvas.setAttribute('aria-label', `3D view of ${one.name}. The arrow keys turn it, plus and minus bring it nearer and further, F fits it.`)
      footer()
      showLayout(view)
    } catch (e) {
      // Said first, and for good: whatever else fails after this, the page does not go on saying it is unpacking.
      busy = false
      clearTimeout(watching)
      loaded.delete(one.id)
      const why = `The parts of ${one.name} could not be shown: ${e instanceof Error ? e.message : String(e)}`
      said.textContent = why
      said.hidden = false
      try {
        panel.sync()
      } catch {
        // The controls stay as they were.
      }
      said.textContent = why
      said.hidden = false
    }
  }

  /** Anything the person changes by hand: the saved view that was applied is no longer what is on screen. */
  const changed = (): void => void (state().view = null)

  const planeAt = (axis: Axis, t: number, flip: boolean): SectionPlane => {
    const box = boxOf()
    const i = 'xyz'.indexOf(axis)
    const plane = planeOf({ axis, at: box.min[i] + Math.min(Math.max(t, 0), 1) * (box.max[i] - box.min[i]) })!
    return flip ? { origin: plane.origin, normal: plane.normal.map((c) => -c + 0) as Vec3 } : plane
  }

  const host: PanelHost = {
    data,
    object: () => object,
    state,
    parts,
    nothingApart: () => {
      const why = nothingApart(state().explode[state().layout] ?? NO_EXPLODE, ruled())
      return why === 'one part' ? 'One part: there is nothing to draw apart.' : why === 'shared centre' && (state().explode[state().layout]?.axis ?? 'centre') === 'centre' ? 'These parts share a centre: choose an axis.' : null
    },
    ortho: () => model.getCamera().ortho,
    rows: () => (state().marks ? rows() : []),
    busy: () => busy,
    setObject(id) {
      const one = data.objects.find((candidate) => candidate.id === id)
      if (one && one !== object && !busy) void show(one, 'iso')
    },
    setLayout(name) {
      if (!object.layouts.includes(name) || name === state().layout) return
      const st = state()
      st.layout = name
      // A cut is of the layout it was made in.
      st.section = null
      st.cut = null
      changed()
      showLayout()
    },
    setPart(name, visible) {
      state().visible[name] = visible
      changed()
      refresh()
    },
    setExplode(amount, axis) {
      const st = state()
      const had = st.explode[st.layout] ?? NO_EXPLODE
      const next = explodeOf({ ...had, amount, ...(axis ? { axis } : {}) }) ?? had
      st.explode[st.layout] = next
      // Never both (`neverBoth`, the app's rule): drawing the parts apart puts the section to rest.
      if (neverBoth(next, st.section, 'explode').section === null) {
        st.section = null
        st.cut = null
      }
      changed()
      refresh()
      keepInView()
    },
    setSection(axis, t = 0.5) {
      const st = state()
      if (axis === null) {
        st.section = null
        st.cut = null
      } else {
        // A cut that is switched on opens towards whoever looks: the half taken away is the one on the camera's side.
        // The app's own rule (`towardsViewer`): a cut switched on in torno opens the same way.
        st.cut = { axis, t: Math.min(Math.max(t, 0), 1), flip: st.cut?.axis === axis ? st.cut.flip : towardsViewer(model.getCamera(), axis) < 0 }
        st.section = planeAt(axis, st.cut.t, st.cut.flip)
        // Never both (`neverBoth`, the app's rule): a section puts the parts together.
        const rested = neverBoth(st.explode[st.layout], st.section, 'section').explode
        if (rested) st.explode[st.layout] = rested
      }
      changed()
      refresh()
    },
    flip() {
      const st = state()
      if (!st.section) return
      if (st.cut) {
        st.cut = { ...st.cut, flip: !st.cut.flip }
        st.section = planeAt(st.cut.axis, st.cut.t, st.cut.flip)
      } else st.section = { origin: st.section.origin, normal: st.section.normal.map((c) => -c + 0) as Vec3 }
      changed()
      refresh()
    },
    applyView(name) {
      const view = object.views.find((one) => one.name === name)
      if (!view || !object.layouts.includes(view.layout) || !meshes) return false
      const st = state()
      const relaid = st.layout !== view.layout
      st.layout = view.layout
      for (const part of object.parts) if (part.layout === view.layout) st.visible[part.name] = !view.hidden.includes(part.name)
      // One or the other, as the view holds it.
      st.section = view.section ?? null
      st.cut = null
      const along = view.section ? axisForm(view.section) : null
      if (view.section && along) {
        const box = boxOf()
        const i = 'xyz'.indexOf(along.axis)
        const size = box.max[i] - box.min[i]
        st.cut = { axis: along.axis, t: size > 0 ? Math.min(Math.max((along.at - box.min[i]) / size, 0), 1) : 0.5, flip: along.sign < 0 }
      }
      const had = st.explode[view.layout] ?? NO_EXPLODE
      st.explode[view.layout] = view.explode && !view.section ? view.explode : { ...had, amount: 0 }
      for (const [id, shown] of Object.entries(view.scans ?? {})) if (st.scans[id]) st.scans[id] = { visible: shown.visible ?? st.scans[id].visible, opacity: shown.opacity ?? st.scans[id].opacity }
      st.view = view.name
      if (relaid) {
        model.setParts(parts(), meshes.meshes)
        model.setScans(meshes.scans, st.layout)
        panel.rebuild()
      }
      refresh()
      model.setCamera(view.camera)
      // Framed for where the parts went when it was saved: fitted only if one of them is out of sight now.
      keepInView()
      panel.sync()
      return true
    },
    setMarks(on) {
      state().marks = on
      refresh()
    },
    setResolved(on) {
      state().resolved = on
      refresh()
    },
    setScan(id, view) {
      const had = state().scans[id]
      if (!had) return
      state().scans[id] = { ...had, ...view }
      changed()
      refresh()
    },
    standard(view) {
      model.fit(view)
    },
    fit() {
      model.fit()
    },
    setOrtho(ortho) {
      model.setOrtho(ortho)
      panel.sync()
    },
    lookAt(mark: ExportMark) {
      const row = rows().find((one) => one.mark.id === mark.id)
      model.lookAt(row ? [mark.at[0] + row.by[0], mark.at[1] + row.by[1], mark.at[2] + row.by[2]] : mark.at)
    }
  }
  panelRoot.setAttribute('aria-label', 'Controls')
  const panel = createPanel(panelRoot, host)

  // The theme: the system's until one is chosen by hand, and back to the system's when asked.
  const themeChoice = (): Theme => (document.documentElement.dataset.theme === 'dark' || document.documentElement.dataset.theme === 'light' ? document.documentElement.dataset.theme : 'system')
  const themeDrawn = (): 'light' | 'dark' => {
    const choice = themeChoice()
    return choice === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : choice
  }
  const themes = document.createElement('span')
  themes.className = 'themes'
  themes.setAttribute('role', 'group')
  themes.setAttribute('aria-label', 'Theme')
  const themeButtons = (['system', 'light', 'dark'] as const).map((theme) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark'
    button.dataset.theme = theme
    button.addEventListener('click', () => setTheme(theme))
    themes.append(button)
    return { theme, button }
  })
  function setTheme(theme: Theme): void {
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
    for (const one of themeButtons) one.button.setAttribute('aria-pressed', String(one.theme === theme))
    model.setTheme(themeOf())
    refresh()
  }

  // The footer: what this file is, and in a line that opens, what it is not.
  const foot = document.createElement('footer')
  foot.id = 'foot'
  root.append(foot)
  function footer(): void {
    const line = (text: string): HTMLElement => {
      const p = document.createElement('p')
      p.textContent = text
      return p
    }
    const made = document.createElement('p')
    made.className = 'made'
    const pieces: Array<[string, boolean]> = [['Made with torno', false], [object.name, false], [`r${object.revision}`, true], [dateOf(data.exportedAt), true]]
    pieces.filter(([text]) => text !== '').forEach(([text, numeric], n) => {
      if (n > 0) made.append(' · ')
      const piece = document.createElement('span')
      if (numeric) piece.className = 'num'
      piece.textContent = text
      made.append(piece)
    })
    const about = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = 'About this file'
    const date = dateOf(data.exportedAt)
    about.append(
      summary,
      line(`A copy of ${object.name} as torno built it (r${object.revision}${date ? `, exported ${date}` : ''}), for looking at. It opens by itself and asks nothing of the network.`),
      line("The surfaces are a mesh of triangles, stored to 1/65535 of each part's size. Nothing on this page is measured from it."),
      ...(object.marks?.some((mark) => mark.kind === 'dimension') ? [line(`Dimensions are as measured by torno on r${object.revision}, on the exact geometry. This page measures nothing itself.`)] : []),
      line('Parts drawn apart, and parts cut open, are drawn so for display only: every part is where it was built.'),
      ...(object.scans?.length ? [line('A scan is a reduced copy of the one in torno, and nothing of it is exact.')] : []),
      ...(data.dropped ?? []).map((sentence) => line(`To keep the file small: ${sentence}.`))
    )
    // The line and the theme beside it; what the file is opens above them.
    const bottom = document.createElement('div')
    bottom.className = 'footline'
    bottom.append(made, themes)
    foot.replaceChildren(bottom, about)
  }

  // The drawer of a narrow screen: the panel comes up from the bottom when asked.
  const drawer = document.createElement('button')
  drawer.type = 'button'
  drawer.id = 'drawer'
  drawer.textContent = 'Controls'
  drawer.setAttribute('aria-expanded', 'false')
  drawer.setAttribute('aria-controls', 'panel')
  drawer.addEventListener('click', () => {
    const open = root.dataset.panel !== 'open'
    root.dataset.panel = open ? 'open' : 'closed'
    drawer.setAttribute('aria-expanded', String(open))
    model.resize()
  })
  // Before the controls it brings up, as it is drawn: the keyboard reaches it first.
  root.insertBefore(drawer, panelRoot)

  canvas.tabIndex = 0
  canvas.setAttribute('role', 'application')
  canvas.setAttribute('aria-roledescription', '3D view')
  canvas.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const STEP = Math.PI / 36
    if (e.key === 'ArrowLeft') model.orbit(-STEP, 0)
    else if (e.key === 'ArrowRight') model.orbit(STEP, 0)
    else if (e.key === 'ArrowUp') model.orbit(0, -STEP)
    else if (e.key === 'ArrowDown') model.orbit(0, STEP)
    else if (e.key === '+' || e.key === '=') model.orbit(0, 0, 1.2)
    else if (e.key === '-' || e.key === '_') model.orbit(0, 0, 1 / 1.2)
    else if (e.key === 'f' || e.key === 'F') model.fit()
    else return
    e.preventDefault()
  })

  new ResizeObserver(() => model.resize()).observe(canvas)
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    model.setTheme(themeOf())
    refresh()
  })
  model.resize()
  for (const one of themeButtons) one.button.setAttribute('aria-pressed', String(one.theme === themeChoice()))

  void show(object, 'iso').then(() => {
    window.__tornoExport = {
      state: () => {
        const st = state()
        const moved = offsets()
        return {
          object: object.id,
          layout: st.layout,
          parts: parts().map((part) => ({ name: part.name, visible: st.visible[part.name] !== false, offset: moved[part.name] ?? [0, 0, 0] })),
          explode: st.explode[st.layout] ?? NO_EXPLODE,
          section: st.section,
          marks: st.marks,
          resolved: st.resolved,
          labels,
          theme: themeDrawn(),
          themeChoice: themeChoice(),
          views: object.views.map((view) => view.name),
          view: st.view,
          scans: (object.scans ?? []).map((scan) => ({ id: scan.id, ...(st.scans[scan.id] ?? { visible: true, opacity: 1 }) })),
          ortho: host.ortho(),
          camera: model.getCamera(),
          leaves: leaves()
        }
      },
      setObject: async (id) => {
        const one = data.objects.find((candidate) => candidate.id === id)
        if (one && one !== object) await show(one, 'iso')
      },
      setLayout: host.setLayout,
      setPart: host.setPart,
      setExplode: host.setExplode,
      setSection: host.setSection,
      applyView: host.applyView,
      setMarks: host.setMarks,
      setResolved: host.setResolved,
      setTheme,
      pixel: (fx, fy) => model.pixel(fx, fy),
      ground: () => model.ground(),
      undrawn: () => model.undrawn()
    }
  })
}

// Whatever goes wrong while the page starts, it says so in place of the parts: never controls and an empty view.
try {
  start()
} catch (e) {
  const root = document.getElementById('torno')
  if (root) say(root, `${BROKE} (${e instanceof Error ? e.message : String(e)}).`)
}

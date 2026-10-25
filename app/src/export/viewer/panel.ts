import { type ExplodeState, NO_EXPLODE } from '../../shared/explode'
import { type ExportData, type ExportMark, type ExportObject, type ExportPart, own } from '../../shared/exportdata'
import { number } from '../../shared/format'
import type { SectionPlane, ViewName } from '../../shared/view'

// The page's controls: a slim column beside the view (a drawer from the bottom on a narrow screen). Every
// control is a native one, so the keyboard reaches them all. Every word that came from the workspace (the names
// of objects, layouts, parts and views, the notes of marks) is set as text: nothing here writes markup.

export type Axis = 'x' | 'y' | 'z'

/** How the object on show is looked at. */
export interface PageState {
  layout: string
  visible: Record<string, boolean>
  explode: Record<string, ExplodeState>
  section: SectionPlane | null
  /** The cut as the controls made it: along an axis, at a fraction of the layout's box. Null for none, and for a plane a saved view brought that is along no axis. */
  cut: { axis: Axis; t: number; flip: boolean } | null
  marks: boolean
  /** The labels of resolved marks are drawn too. */
  resolved: boolean
  scans: Record<string, { visible: boolean; opacity: number }>
  /** The saved view that was last applied and not changed since. */
  view: string | null
}

export interface MarkRow { mark: ExportMark; drawn: boolean; why?: string }

/** What the panel asks of the page. */
export interface PanelHost {
  data: ExportData
  object(): ExportObject
  state(): PageState
  /** The parts of the layout on show. */
  parts(): ExportPart[]
  /** Why nothing can be drawn apart in the layout on show, or null. */
  nothingApart(): string | null
  ortho(): boolean
  rows(): MarkRow[]
  /** While an object's parts are being unpacked. */
  busy(): boolean
  setObject(id: string): void
  setLayout(name: string): void
  setPart(name: string, visible: boolean): void
  setExplode(amount: number, axis?: ExplodeState['axis']): void
  setSection(axis: Axis | null, t?: number): void
  flip(): void
  applyView(name: string): boolean
  setMarks(on: boolean): void
  setResolved(on: boolean): void
  setScan(id: string, view: { visible?: boolean; opacity?: number }): void
  standard(view: ViewName): void
  fit(): void
  setOrtho(ortho: boolean): void
  lookAt(mark: ExportMark): void
}

/** `9 Oct 2026`, of an ISO time; nothing for what is no time. */
export function dateOf(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

type Attrs = Record<string, string | boolean | undefined>

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue
    if (name === 'class') made.className = String(value)
    else made.setAttribute(name, value === true ? '' : value)
  }
  made.append(...children)
  return made
}

const num = (text: string): HTMLElement => el('span', { class: 'num' }, text)

const STANDARD: Array<{ view: ViewName; label: string }> = [
  { view: 'iso', label: 'Iso' },
  { view: 'front', label: 'Front' },
  { view: 'right', label: 'Right' },
  { view: 'top', label: 'Top' }
]
const AXES: Axis[] = ['x', 'y', 'z']

export interface Panel {
  /** Builds the controls again: for another object, or another layout. What had the focus keeps it. */
  rebuild(): void
  /** Sets every control to what the page shows. */
  sync(): void
}

export function createPanel(root: HTMLElement, host: PanelHost): Panel {
  let syncs: Array<() => void> = []
  let counter = 0

  /** A button that stays pressed while `pressed()` says so. */
  const toggle = (label: string, key: string, pressed: () => boolean, press: () => void, attrs: Attrs = {}): HTMLButtonElement => {
    const button = el('button', { type: 'button', class: 'button', 'data-k': key, ...attrs }, label)
    button.addEventListener('click', press)
    syncs.push(() => button.setAttribute('aria-pressed', String(pressed())))
    return button
  }
  const press = (label: string, key: string, onPress: () => void, attrs: Attrs = {}): HTMLButtonElement => {
    const button = el('button', { type: 'button', class: 'button', 'data-k': key, ...attrs }, label)
    button.addEventListener('click', onPress)
    return button
  }
  const section = (title: string, ...children: Array<Node | string>): HTMLElement => {
    const id = `s${++counter}`
    return el('section', { class: 'block', 'aria-labelledby': id }, el('h2', { id }, title), ...children)
  }
  const range = (label: string, key: string, value: () => number, set: (value: number) => void, enabled: () => boolean = () => true, said: (value: number) => string = (v) => `${Math.round(v * 100)} %`): HTMLInputElement => {
    const input = el('input', { type: 'range', min: '0', max: '100', step: '1', 'aria-label': label, 'data-k': key })
    input.addEventListener('input', () => set(Number(input.value) / 100))
    syncs.push(() => {
      const now = String(Math.round(value() * 100))
      if (input.value !== now) input.value = now
      // Read out as what it is, not as a bare number.
      input.setAttribute('aria-valuetext', said(value()))
      input.disabled = !enabled()
    })
    return input
  }

  function head(): HTMLElement {
    const object = host.object()
    const made = el('header', { class: 'head' }, el('h1', {}, el('span', { class: 'name' }, object.name), ' ', num(`r${object.revision}`)))
    if (host.data.objects.length > 1) {
      const list = el('ul', { class: 'objects', 'aria-label': 'Projects in this file' })
      for (const one of host.data.objects) {
        const button = el('button', { type: 'button', class: 'object', 'data-k': `object:${one.id}` }, el('span', { class: 'name' }, one.name), num(`r${one.revision}`))
        button.addEventListener('click', () => host.setObject(one.id))
        syncs.push(() => {
          if (one.id === host.object().id) button.setAttribute('aria-current', 'true')
          else button.removeAttribute('aria-current')
          button.disabled = host.busy()
        })
        list.append(el('li', {}, button))
      }
      made.append(list)
    }
    return made
  }

  function layouts(): HTMLElement | null {
    const object = host.object()
    if (object.layouts.length < 2) return null
    const group = el('div', { class: 'row', role: 'group', 'aria-label': 'Layout' })
    for (const name of object.layouts) group.append(toggle(name, `layout:${name}`, () => host.state().layout === name, () => host.setLayout(name)))
    return section('Layout', group)
  }

  function parts(): HTMLElement {
    const list = el('ul', { class: 'parts' })
    for (const part of host.parts()) {
      const box = el('input', { type: 'checkbox', 'data-k': `part:${part.name}` })
      box.addEventListener('change', () => host.setPart(part.name, box.checked))
      syncs.push(() => (box.checked = host.state().visible[part.name] !== false))
      const swatch = el('span', { class: 'swatch', 'aria-hidden': 'true' })
      swatch.style.background = part.color
      list.append(el('li', {}, el('label', {}, box, swatch, el('span', { class: 'name' }, part.name))))
    }
    return section('Parts', list)
  }

  function explode(): HTMLElement {
    const now = (): ExplodeState => host.state().explode[host.state().layout] ?? NO_EXPLODE
    const readout = num('')
    const why = el('p', { class: 'hint' })
    const slider = range('Explode', 'explode', () => now().amount, (amount) => host.setExplode(amount), () => host.nothingApart() === null)
    const axes = el('div', { class: 'row', role: 'group', 'aria-label': 'Direction the parts go apart in' })
    axes.append(toggle('Centre', 'axis:centre', () => now().axis === 'centre', () => host.setExplode(now().amount, 'centre'), { title: 'Away from the centre' }))
    for (const axis of AXES) axes.append(toggle(axis.toUpperCase(), `axis:${axis}`, () => now().axis === axis, () => host.setExplode(now().amount, axis), { title: `Apart along ${axis}` }))
    syncs.push(() => {
      readout.textContent = `${number(now().amount * 100)} %`
      const none = host.nothingApart()
      why.textContent = none ?? (now().amount > 0 ? 'Drawn apart for display only: the parts are where they were built.' : '')
      why.hidden = why.textContent === ''
    })
    return section('Explode', el('div', { class: 'slider' }, slider, readout), axes, why)
  }

  function cut(): HTMLElement {
    const state = (): PageState => host.state()
    const axes = el('div', { class: 'row', role: 'group', 'aria-label': 'Section' })
    axes.append(toggle('Off', 'cut:off', () => state().section === null, () => host.setSection(null)))
    for (const axis of AXES) axes.append(toggle(axis.toUpperCase(), `cut:${axis}`, () => state().cut?.axis === axis, () => host.setSection(axis, state().cut?.t ?? 0.5), { title: `Cut across ${axis}` }))
    const slider = range('Where the section cuts', 'cut', () => state().cut?.t ?? 0.5, (t) => host.setSection(state().cut?.axis ?? 'z', t), () => state().cut !== null, (t) => `${Math.round(t * 100)} % of the way along ${state().cut?.axis ?? 'z'}`)
    const flip = press('Flip', 'flip', () => host.flip())
    const why = el('p', { class: 'hint' })
    syncs.push(() => {
      flip.disabled = state().section === null
      why.textContent = state().section === null ? '' : `${state().cut === null ? 'Cut as the saved view has it. ' : ''}Cut open for display only. Solid parts are drawn open, their inside in a darker tone: this page draws no cut faces.`
      why.hidden = why.textContent === ''
    })
    return section('Section', axes, el('div', { class: 'slider' }, slider, flip), why)
  }

  function views(): HTMLElement {
    const object = host.object()
    const made = section('Views')
    if (object.views.length > 0) {
      const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Saved views' })
      for (const view of object.views) {
        const gone = !object.layouts.includes(view.layout)
        const chip = toggle(view.name, `view:${view.name}`, () => host.state().view === view.name, () => host.applyView(view.name), { class: 'viewchip', title: gone ? `Of the layout ${view.layout}, which this build does not have` : undefined })
        chip.disabled = gone
        chips.append(chip)
      }
      made.append(chips)
    }
    const standard = el('div', { class: 'row', role: 'group', 'aria-label': 'Standard views' })
    for (const { view, label } of STANDARD) standard.append(press(label, `standard:${view}`, () => host.standard(view)))
    standard.append(press('Fit', 'fit', () => host.fit(), { title: 'Fit what is drawn in view (F)' }))
    const projection = el('div', { class: 'row', role: 'group', 'aria-label': 'Projection' })
    projection.append(toggle('Perspective', 'persp', () => !host.ortho(), () => host.setOrtho(false)), toggle('Ortho', 'ortho', () => host.ortho(), () => host.setOrtho(true)))
    made.append(standard, projection)
    return made
  }

  function marks(): HTMLElement | null {
    const object = host.object()
    if (!object.marks || object.marks.length === 0) return null
    const box = el('input', { type: 'checkbox', 'data-k': 'marks' })
    box.addEventListener('change', () => host.setMarks(box.checked))
    syncs.push(() => (box.checked = host.state().marks))
    const list = el('ul', { class: 'marks' })
    const here = el('p', { class: 'hint' })
    const rowsOf = new Map<string, { item: HTMLElement; note: HTMLElement }>()
    for (const mark of object.marks) {
      const id = num(mark.id)
      id.classList.add('mark-id')
      id.dataset.author = mark.author
      const body = el('span', { class: 'mark-body' })
      if (mark.kind === 'dimension') {
        const line = el('span', { class: 'mark-value' }, num(mark.text ?? '—'))
        if (mark.verdict) line.append(' ', el('span', { class: 'verdict', 'data-verdict': mark.verdict }, mark.verdict === 'pass' ? '✓ passes' : '✗ fails'))
        if (mark.expected) {
          const expected = num(mark.expected)
          expected.classList.add('whole')
          line.append(' ', el('span', { class: 'muted' }, 'should be ', expected))
        }
        body.append(line)
        if (mark.how) body.append(el('span', { class: 'muted' }, mark.how))
      }
      if (mark.says) body.append(el('span', { class: 'muted' }, mark.says))
      if (mark.note) body.append(el('span', { class: 'note' }, mark.note))
      const flags = [mark.author === 'agent' ? 'by the agent' : '', mark.status === 'resolved' ? 'resolved' : '', mark.moved ? 'moved since it was placed' : '', mark.unchecked ? `not checked on r${object.revision}` : ''].filter(Boolean)
      if (flags.length > 0) body.append(el('span', { class: 'muted' }, flags.join(' · ')))
      const why = el('span', { class: 'muted' })
      body.append(why)
      const button = el('button', { type: 'button', class: 'mark', 'data-k': `mark:${mark.id}`, title: 'Turn the view to it' }, id, body)
      button.addEventListener('click', () => host.lookAt(mark))
      const item = el('li', {}, button)
      rowsOf.set(mark.id, { item, note: why })
      list.append(item)
    }
    syncs.push(() => {
      const rows = host.rows()
      for (const [id, row] of rowsOf) {
        const found = rows.find((one) => one.mark.id === id)
        row.item.hidden = found === undefined
        row.note.textContent = found?.why ?? ''
        row.note.hidden = !found?.why
      }
      list.hidden = rows.length === 0
      here.textContent = rows.length === 0 ? `None in the layout ${host.state().layout}.` : ''
      here.hidden = rows.length > 0
    })
    const date = dateOf(host.data.exportedAt)
    // Resolved marks are in the list; their labels are drawn only when asked.
    const settled = object.marks.some((mark) => mark.status === 'resolved')
    const more = el('input', { type: 'checkbox', 'data-k': 'resolved' })
    more.addEventListener('change', () => host.setResolved(more.checked))
    syncs.push(() => {
      more.checked = host.state().resolved
      more.disabled = !host.state().marks
    })
    const honest = el('p', { class: 'hint' }, 'A value is as torno measured it on the exact geometry of ', num(`r${object.revision}`), ...(date ? [', exported ', num(date)] : []), '. This page measures nothing.')
    return section('Marks', el('label', { class: 'check' }, box, 'Show marks and dimensions'), ...(settled ? [el('label', { class: 'check' }, more, 'Label the resolved ones too')] : []), list, here, ...(object.marks.some((mark) => mark.kind === 'dimension') ? [honest] : []))
  }

  function scans(): HTMLElement | null {
    const object = host.object()
    if (!object.scans || object.scans.length === 0) return null
    const list = el('ul', { class: 'scans' })
    for (const scan of object.scans) {
      const here = (): boolean => own(scan.placed, host.state().layout) !== undefined
      const view = (): { visible: boolean; opacity: number } => host.state().scans[scan.id] ?? { visible: true, opacity: 1 }
      const box = el('input', { type: 'checkbox', 'data-k': `scan:${scan.id}` })
      box.addEventListener('change', () => host.setScan(scan.id, { visible: box.checked }))
      const opacity = range(`Opacity of ${scan.id}`, `scan-opacity:${scan.id}`, () => view().opacity, (value) => host.setScan(scan.id, { opacity: Math.max(value, 0.05) }), () => here() && view().visible)
      const where = el('span', { class: 'muted' })
      syncs.push(() => {
        box.checked = view().visible
        box.disabled = !here()
        where.textContent = here() ? '' : `not placed in ${host.state().layout}`
        where.hidden = here()
      })
      list.append(el('li', {}, el('label', {}, box, num(scan.id), el('span', { class: 'name' }, scan.name)), opacity, where))
    }
    return section('Scans', list, el('p', { class: 'hint' }, 'A scan here is a reduced copy, and nothing of it is exact.'))
  }

  const panel: Panel = {
    rebuild() {
      const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.dataset.k : undefined
      syncs = []
      counter = 0
      const blocks = [head(), layouts(), parts(), explode(), cut(), views(), marks(), scans()].filter((block): block is HTMLElement => block !== null)
      root.replaceChildren(...blocks)
      panel.sync()
      if (active !== undefined) [...root.querySelectorAll<HTMLElement>('[data-k]')].find((one) => one.dataset.k === active)?.focus()
    },
    sync() {
      for (const sync of syncs) sync()
    }
  }
  return panel
}

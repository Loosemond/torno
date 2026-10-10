import { describe, expect, it } from 'vitest'
import { MAX_PROPOSALS, MAX_VIEWS, findView, goneText, holdsText, proposalToDrop, savedViewOf, savedViewsOf, viewGone, viewNameRefusal, viewSummary, type SavedView } from './views'

const camera = { position: [120, -90, 60], target: [0, 0, 6], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
const view = (name: string, more: Partial<SavedView> = {}): SavedView => ({ name, author: 'user', layout: 'assembly', camera: camera as SavedView['camera'], hidden: [], at: '2026-10-09T21:14:03.000Z', ...more })

describe('savedViewOf', () => {
  it('keeps a view as it was saved', () => {
    const full = view('Hinge side', { hidden: ['lid'], explode: { amount: 0.4, scale: 1, axis: 'z' }, scans: { S1: { visible: false, opacity: 0.5 } } })
    expect(savedViewOf(JSON.parse(JSON.stringify(full)))).toEqual(full)
  })

  it('keeps of a damaged view what is one, and nothing of what is none', () => {
    expect(savedViewOf({ ...view('  Top  side '), hidden: ['lid', 3, 'lid'], scans: { S1: { visible: 'no', opacity: 7, colour: 'plain' }, lid: { visible: false } }, author: 'me' })).toBeNull()
    expect(savedViewOf({ ...view('  Top  side '), hidden: ['lid', 3, 'lid'], scans: { S1: { visible: 'no', opacity: 7, colour: 'plain' }, lid: { visible: false } } })).toEqual(view('Top  side', { hidden: ['lid'], scans: { S1: { opacity: 1 } } }))
    for (const broken of [null, 'view', { ...view('a'), camera: { ...camera, target: camera.position } }, { ...view('a'), layout: 7 }, { ...view(''), name: ' ' }, { ...view('iso') }, { ...view('Front') }, { ...view('x'.repeat(41)) }, { ...view('two\nlines') }, { ...view('bell\u0007') }]) {
      expect(savedViewOf(broken)).toBeNull()
    }
  })

  it('holds a section or an explode, never both: the section stays', () => {
    const both = savedViewOf({ ...view('Cut'), section: { origin: [0, 0, 3], normal: [0, 0, 2] }, explode: { amount: 0.5 } })!
    expect(both.section).toEqual({ origin: [0, 0, 3], normal: [0, 0, 1] })
    expect(both.explode).toBeUndefined()
    // An explode of nothing is not kept.
    expect(savedViewOf({ ...view('Flat'), explode: { amount: 0 } })!.explode).toBeUndefined()
  })

  it('marks only an agent\'s view as proposed, and keeps its note to a line', () => {
    expect(savedViewOf({ ...view('Mine'), proposed: true })!.proposed).toBeUndefined()
    const agents = savedViewOf({ ...view('Wall', { author: 'agent' }), proposed: true, note: ` the wall\nM7 is about ${'x'.repeat(300)}` })!
    expect(agents.proposed).toBe(true)
    expect(agents.note).toHaveLength(200)
    expect(agents.note).not.toContain('\n')
  })
})

describe('savedViewsOf', () => {
  it('drops a broken view and a second of the same name, and stops at the most there may be', () => {
    expect(savedViewsOf([view('A'), { name: 'broken' }, view('a'), view('B')]).map((v) => v.name)).toEqual(['A', 'B'])
    expect(savedViewsOf(Array.from({ length: 40 }, (_, i) => view(`v${i}`)))).toHaveLength(MAX_VIEWS)
    expect(savedViewsOf('views')).toEqual([])
  })
})

describe('names', () => {
  const views = [view('Hinge side'), view('Wall', { author: 'agent', proposed: true }), view('Kept', { author: 'agent' })]
  it('finds a view whatever the case', () => {
    expect(findView(views, 'hinge SIDE')?.name).toBe('Hinge side')
    expect(findView(views, ' Hinge side ')?.name).toBe('Hinge side')
    expect(findView(views, 'hinge')).toBeUndefined()
  })
  it('lets the person save over any view, and the agent only over its own proposal', () => {
    expect(viewNameRefusal('Hinge side', views, 'user')).toBeNull()
    expect(viewNameRefusal('New', views, 'agent')).toBeNull()
    expect(viewNameRefusal('wall', views, 'agent')).toBeNull()
    expect(viewNameRefusal('hinge side', views, 'agent')).toBe('the user has a view named "Hinge side": choose another name')
    expect(viewNameRefusal('Kept', views, 'agent')).toBe('the user kept the view "Kept": choose another name')
  })
  it('refuses a name that is none, a standard view\'s, and one more than there may be', () => {
    expect(viewNameRefusal(' ', views, 'user')).toBe('A view needs a name')
    expect(viewNameRefusal('TOP', views, 'user')).toBe('"TOP" is a standard view: choose another name')
    expect(viewNameRefusal('x'.repeat(41), views, 'user')).toBe('A name has at most 40 characters')
    expect(viewNameRefusal('tab\there', views, 'user')).toBe('A name is one line')
    const full = Array.from({ length: MAX_VIEWS }, (_, i) => view(`v${i}`))
    expect(viewNameRefusal('one more', full, 'user')).toBe('There are 24 views: remove one first')
    expect(viewNameRefusal('v3', full, 'user')).toBeNull()
  })
  it('lets a view be given another name, but not that of another view', () => {
    expect(viewNameRefusal('hinge SIDE', views, 'user', 'Hinge side')).toBeNull()
    expect(viewNameRefusal('Wall', views, 'user', 'Hinge side')).toBe('There is a view named "Wall" already')
    const full = Array.from({ length: MAX_VIEWS }, (_, i) => view(`v${i}`))
    expect(viewNameRefusal('other', full, 'user', 'v3')).toBeNull()
  })
  it('summarises a view for the agent', () => {
    expect(viewSummary(view('Wall', { author: 'agent', proposed: true, note: 'thin', section: { origin: [0, 0, 0], normal: [0, 0, 1] } }))).toEqual({ name: 'Wall', by: 'agent', proposed: true, layout: 'assembly', section: true, note: 'thin' })
    expect(viewSummary(view('Apart', { explode: { amount: 1, scale: 1, axis: 'x' } }))).toEqual({ name: 'Apart', by: 'user', layout: 'assembly', exploded: true })
    // How many parts it hides, when it hides any.
    expect(viewSummary(view('Tub', { hidden: ['lid', 'tray'] }))).toEqual({ name: 'Tub', by: 'user', layout: 'assembly', hidden: 2 })
  })
  it('says in a few words what a view holds', () => {
    expect(holdsText(view('A'))).toBe('layout assembly')
    expect(holdsText(view('A', { hidden: ['lid'], explode: { amount: 0.6, scale: 1, axis: 'centre' } }))).toBe('layout assembly · exploded 60 % from the centre · 1 part hidden')
    expect(holdsText(view('A', { hidden: ['lid', 'tray'], section: { origin: [0, 0, 3], normal: [0, 0, 1] } }))).toBe('layout assembly · section · 2 parts hidden')
  })
})

describe('what a view names that is no longer there', () => {
  const saved = view('Hinge side', { hidden: ['lid', 'clip', 'pin'], scans: { S1: { visible: true }, S4: { visible: false } } })
  it('finds the parts and the scans that are gone, and a layout that is', () => {
    expect(viewGone(saved, { layouts: ['assembly'], parts: ['tub', 'lid'], scans: ['S1'] })).toEqual({ layout: false, parts: ['clip', 'pin'], scans: ['S4'] })
    expect(viewGone(saved, { layouts: ['print'], parts: [], scans: ['S1', 'S4'] })).toEqual({ layout: true, parts: [], scans: [] })
    // The scans are not known: nothing is said of them.
    expect(viewGone(saved, { layouts: ['assembly'], parts: ['tub', 'lid', 'clip', 'pin'] })).toEqual({ layout: false, parts: [], scans: [] })
  })
  it('says it quietly', () => {
    expect(goneText({ layout: false, parts: [], scans: [] })).toBe('')
    expect(goneText({ layout: false, parts: ['clip', 'pin'], scans: [] })).toBe('2 parts gone')
    expect(goneText({ layout: false, parts: ['clip'], scans: ['S4'] })).toBe('1 part and 1 scan gone')
    expect(goneText({ layout: false, parts: [], scans: ['S4', 'S5'] })).toBe('2 scans gone')
    expect(goneText({ layout: true, parts: [], scans: [] })).toBe('layout gone')
  })
})

describe('proposals', () => {
  it('names the oldest proposal to drop once there are as many as may be, and none before', () => {
    const proposals = Array.from({ length: MAX_PROPOSALS }, (_, i) => view(`p${i}`, { author: 'agent', proposed: true }))
    expect(proposalToDrop([view('Mine'), ...proposals], 'new')).toBe('p0')
    expect(proposalToDrop([view('Mine'), ...proposals.slice(1)], 'new')).toBeNull()
    // Replacing one of its own adds none.
    expect(proposalToDrop([view('Mine'), ...proposals], 'P5')).toBeNull()
  })
})

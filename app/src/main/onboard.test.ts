import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OnboardDraft } from '../shared/bridge'
import type { Scene } from '../shared/scene'
import type { ObjectInfo } from '../shared/workspace'
import { type ImageBytes, MOST_IMAGES, checkedImage, objectSummary, onboardObject, onboardPrompt, readThumb, sessionRunning } from './onboard'

/** A PNG with the header of a picture w x h (and not a picture after it). */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, w)
  new DataView(b.buffer).setUint32(20, h)
  return b
}
/** A JPEG with a comment segment, then a start of frame of w x h. */
function jpeg(w: number, h: number): Uint8Array {
  const b = new Uint8Array(32)
  b.set([0xff, 0xd8, 0xff, 0xfe, 0, 6, 1, 2, 3, 4, 0xff, 0xc0, 0, 8, 8])
  const v = new DataView(b.buffer)
  v.setUint16(15, h)
  v.setUint16(17, w)
  return b
}
const image = (bytes: Uint8Array): ImageBytes => checkedImage(bytes)!

describe('checkedImage', () => {
  it('takes a PNG or a JPEG whose long edge is at most 2000, and says which', () => {
    expect(checkedImage(png(1280, 720))).toMatchObject({ mediaType: 'image/png', width: 1280, height: 720 })
    expect(checkedImage(jpeg(2000, 1500))).toMatchObject({ mediaType: 'image/jpeg', width: 2000, height: 1500 })
  })

  it('refuses a longer edge, a WebP, a PDF, too few bytes, a size of 0 and a JPEG with no frame header', () => {
    expect(checkedImage(png(2001, 10))).toBeNull()
    expect(checkedImage(jpeg(10, 2001))).toBeNull()
    expect(checkedImage(png(0, 10))).toBeNull()
    expect(checkedImage(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBeNull()
    expect(checkedImage(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBeNull()
    expect(checkedImage(new Uint8Array(0))).toBeNull()
    expect(checkedImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull()
    expect(checkedImage('nope' as unknown as Uint8Array)).toBeNull()
  })

  it('refuses a picture of more than 5 MB', () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1)
    big.set(png(10, 10))
    expect(checkedImage(big)).toBeNull()
  })
})

describe('objectSummary', () => {
  const part = (name: string, min: number[], max: number[], exact?: boolean) => ({ name, layout: 'assembly', bbox: { min, max }, ...(exact === undefined ? {} : { bboxExact: exact }) })
  const scene = (parts: unknown[], layouts = ['assembly']) => ({ model: 'x', layouts, parts }) as unknown as Scene

  it('says "not built in this run" with no build', () => {
    expect(objectSummary(undefined)).toBe('not built in this run')
  })

  it('names the parts and gives the box of the first layout, and whether the kernel says it is exact', () => {
    expect(objectSummary(scene([part('base', [0, 0, 0], [40, 20, 5], true), part('lid', [0, 0, 5], [40, 20, 10], true)]))).toBe('2 parts: base, lid; box 40 x 20 x 10 mm, exact')
    expect(objectSummary(scene([part('base', [0, 0, 0], [40, 20, 5], true), part('lid', [0, 0, 5], [40, 20, 10], false)]))).toContain('mm, approximate')
    expect(objectSummary(scene([part('base', [0, 0, 0], [40.123456, 20, 5])]))).toContain('box 40.12 x 20 x 5 mm, approximate')
  })

  it('shortens a long list of parts, and says when there are none', () => {
    const many = Array.from({ length: 12 }, (_, i) => part(`p${i}`, [0, 0, 0], [1, 1, 1], true))
    expect(objectSummary(scene(many))).toContain('12 parts: p0, p1, p2, p3, p4, p5, p6, p7 and 4 more;')
    expect(objectSummary(scene([]))).toBe('built, with no parts')
    expect(objectSummary(scene([part('only', [0, 0, 0], [1, 2, 3], true)]))).toMatch(/^1 part: only;/)
  })
})

const full = () => ({
  name: 'cable-clip',
  description: 'A clip that holds a 6 mm cable\nto the edge of a desk.',
  items: [
    { file: 'reference/photo-1.jpg', note: 'the desk edge', image: image(jpeg(1280, 960)) },
    { file: 'reference/doodle-1.png', note: 'the shape I want', image: image(png(1200, 800)) }
  ],
  scans: [
    { id: 'S1', file: 'desk.stl', note: 'the edge, scanned' },
    { id: null, file: 'bad.stl', note: 'another try', problem: 'the file has no triangles' }
  ],
  objects: [
    { name: 'lid', summary: '1 part: lid; box 40 x 20 x 5 mm, exact', note: 'mounts on this', thumb: image(png(480, 360)) },
    { name: 'base', summary: 'not built in this run', note: '' }
  ]
})

describe('onboardPrompt', () => {
  it('writes the text of the plan, with every kind of item', () => {
    const { text, blocks } = onboardPrompt(full())
    expect(text).toBe(
      [
        'This is a new object, cable-clip, made in torno just now. What it is, in the person\'s words:',
        '',
        'A clip that holds a 6 mm cable\nto the edge of a desk.',
        '',
        'What they gave (all of it is also in brief.md; files are in reference/):',
        '- reference/photo-1.jpg: the desk edge (attached below)',
        '- reference/doodle-1.png: the shape I want (attached below)',
        '- Scan S1 "desk.stl": the edge, scanned. It is imported into this object and is not aligned: the person aligns it in torno, and mcp__torno__scan_clash and mcp__torno__scan_deviation need that. Read it with mcp__torno__scans and mcp__torno__scan_section.',
        '- Scan "bad.stl": another try. It could not be imported (the file has no triangles); the file is the person\'s to give again.',
        '- ../lid/ (another object of this workspace: 1 part: lid; box 40 x 20 x 5 mm, exact; its picture is attached below): mounts on this',
        '- ../base/ (another object of this workspace: not built in this run)',
        '',
        'cable_clip.py is torno\'s placeholder (a 20 mm cube). Read brief.md, look at what was given, ask what you need to know, then replace the placeholder with the real model.'
      ].join('\n')
    )
    expect(blocks).toHaveLength(4)
    expect(blocks[0]).toEqual({ type: 'text', text })
    expect(blocks.slice(1).map((b) => (b as { source: { media_type: string } }).source.media_type)).toEqual(['image/jpeg', 'image/png', 'image/png'])
  })

  it('writes a text to hold that says no picture is attached and names the files of the pictures', () => {
    const { text, held } = onboardPrompt(full())
    expect(text).toContain('(attached below)')
    expect(held).not.toContain('attached below')
    expect(held).not.toContain('is attached')
    expect(held).toContain('- reference/photo-1.jpg: the desk edge (not attached: read reference/photo-1.jpg)')
    expect(held).toContain('- reference/doodle-1.png: the shape I want (not attached: read reference/doodle-1.png)')
    expect(held).toContain('; its picture: ../lid/.torno/thumb.png): mounts on this')
    expect(held).toContain('- ../base/ (another object of this workspace: not built in this run)')
  })

  it('attaches the pictures in order: photos and doodles, then the pictures of the objects, and no more than 6', () => {
    const input = full()
    input.items = Array.from({ length: 5 }, (_, i) => ({ file: `reference/photo-${i + 1}.png`, note: `n${i + 1}`, image: image(png(10 + i, 10)) }))
    input.items.push({ file: 'reference/doodle-1.png', note: 'last', image: image(png(99, 10)) })
    input.items.push({ file: 'reference/doodle-2.png', note: 'beyond', image: image(png(98, 10)) })
    const { text, blocks } = onboardPrompt(input)
    expect(MOST_IMAGES).toBe(6)
    const images = blocks.filter((b) => b.type === 'image')
    expect(images).toHaveLength(6)
    const widths = images.map((b) => new DataView(new Uint8Array(Buffer.from((b as { source: { data: string } }).source.data, 'base64')).buffer).getUint32(16))
    expect(widths).toEqual([10, 11, 12, 13, 14, 99])
    expect(text).toContain('- reference/doodle-2.png: beyond (not attached: read reference/doodle-2.png)')
    expect(text).toContain('- ../lid/ (another object of this workspace: 1 part: lid; box 40 x 20 x 5 mm, exact; its picture is not attached): mounts on this')
  })

  it('names an item with no usable picture as not attached, and takes every note as one line', () => {
    const input = full()
    input.items = [{ file: 'reference/photo-1.webp', note: 'line one\n\n- injected: yes\t  end', image: undefined as unknown as ImageBytes }]
    input.scans = []
    input.objects = []
    const { text, blocks } = onboardPrompt(input)
    expect(text).toContain('- reference/photo-1.webp: line one - injected: yes end (not attached: read reference/photo-1.webp)')
    expect(blocks).toHaveLength(1)
  })

  it('folds the name of a scan file and of an object to one line', () => {
    const { text } = onboardPrompt({ name: 'x', description: 'd', items: [], scans: [{ id: 'S1', file: 'a\n- injected.stl', note: '' }], objects: [{ name: 'o\n- injected', summary: 's', note: '' }] })
    expect(text).not.toMatch(/^- injected/m)
  })

  it('leaves out the list of what they gave when they gave nothing', () => {
    const { text } = onboardPrompt({ name: 'x', description: 'A thing.', items: [], scans: [], objects: [] })
    expect(text).toBe(
      'This is a new object, x, made in torno just now. What it is, in the person\'s words:\n\nA thing.\n\nx.py is torno\'s placeholder (a 20 mm cube). Read brief.md, look at what was given, ask what you need to know, then replace the placeholder with the real model.'
    )
  })
})

describe('readThumb', () => {
  let base: string
  beforeEach(() => void (base = mkdtempSync(join(realpathSync(tmpdir()), 'torno-thumb-'))))
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('reads the picture on file, and nothing that is no picture, a link or too big', async () => {
    const dir = join(base, 'o')
    mkdirSync(join(dir, '.torno'), { recursive: true })
    expect(await readThumb(dir)).toBeUndefined()
    writeFileSync(join(dir, '.torno', 'thumb.png'), png(480, 360))
    expect(await readThumb(dir)).toMatchObject({ mediaType: 'image/png', width: 480 })
    writeFileSync(join(dir, '.torno', 'thumb.png'), 'not a picture')
    expect(await readThumb(dir)).toBeUndefined()
    rmSync(join(dir, '.torno', 'thumb.png'))
    writeFileSync(join(base, 'elsewhere.png'), png(480, 360))
    symlinkSync(join(base, 'elsewhere.png'), join(dir, '.torno', 'thumb.png'))
    expect(await readThumb(dir)).toBeUndefined()
  })
})

describe('sessionRunning', () => {
  it('is true for a session that runs and for one that is starting, false otherwise', () => {
    const sessions = (running: boolean, starting: boolean) => ({ current: () => (running ? ({} as never) : null), isStarting: () => starting })
    expect(sessionRunning(sessions(true, false), 'x')).toBe(true)
    expect(sessionRunning(sessions(false, true), 'x')).toBe(true)
    expect(sessionRunning(sessions(false, false), 'x')).toBe(false)
    expect(sessionRunning(null, 'x')).toBe(false)
  })
})

describe('onboardObject', () => {
  let base: string
  const calls: string[] = []
  let sent: Array<{ sessionId: string; blocks: Array<{ type: string; text?: string }> }>
  const obj = (id: string): ObjectInfo => ({ id, name: id, dir: join(base, id), model: null })

  function deps(over: Partial<Parameters<typeof onboardObject>[0]> = {}): Parameters<typeof onboardObject>[0] {
    return {
      object: (id) => (['cable-clip', 'lid', 'base'].includes(id) ? obj(id) : undefined),
      running: () => false,
      importScan: async (_id, path) => {
        calls.push(`import ${path}`)
        return { id: 'S1', name: 'desk' }
      },
      start: async (o) => {
        calls.push(`start ${o.id}`)
        return { sessionId: 'sess', view: 'chat' }
      },
      prompt: (sessionId, blocks) => void sent.push({ sessionId, blocks }),
      scene: () => undefined,
      ...over
    }
  }
  const draft = (over: Partial<OnboardDraft> = {}): OnboardDraft => ({ description: 'A clip.', items: [], scans: [], objects: [], ...over })

  beforeEach(() => {
    base = mkdtempSync(join(realpathSync(tmpdir()), 'torno-onboard-'))
    for (const id of ['cable-clip', 'lid', 'base']) mkdirSync(join(base, id, 'reference'), { recursive: true })
    writeFileSync(join(base, 'cable-clip', 'reference', 'photo-1.jpg'), 'x')
    writeFileSync(join(base, 'cable-clip', 'reference', 'doodle-1.png'), 'x')
    calls.length = 0
    sent = []
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('imports the scans, then starts the session, then sends one prompt with everything', async () => {
    mkdirSync(join(base, 'lid', '.torno'))
    writeFileSync(join(base, 'lid', '.torno', 'thumb.png'), png(480, 360))
    const out = await onboardObject(
      deps({ scene: (id) => (id === 'lid' ? ({ model: 'lid', layouts: ['assembly'], parts: [{ name: 'lid', layout: 'assembly', bbox: { min: [0, 0, 0], max: [40, 20, 5] }, bboxExact: true }] } as unknown as Scene) : undefined) }),
      'cable-clip',
      draft({
        items: [{ file: 'reference/photo-1.jpg', note: 'desk', image: jpeg(1280, 960) }, { file: 'reference/doodle-1.png', note: 'shape', image: png(1200, 800) }],
        scans: [{ path: '/s/desk.stl', note: 'the edge' }],
        objects: [{ id: 'lid', note: 'mounts on this' }, { id: 'base', note: '' }]
      })
    )
    expect(calls).toEqual(['import /s/desk.stl', 'start cable-clip'])
    expect(out.sessionId).toBe('sess')
    expect(out.problem).toBeUndefined()
    expect(sent).toHaveLength(1)
    expect(sent[0].blocks.map((b) => b.type)).toEqual(['text', 'image', 'image', 'image'])
    const text = sent[0].blocks[0].text!
    expect(out.prompt).toBe(text)
    expect(out.held).not.toContain('attached below')
    for (const note of ['desk', 'shape', 'the edge', 'mounts on this']) expect(text).toContain(note)
    expect(text).toContain('Scan S1 "desk.stl"')
    expect(text).toContain('../lid/ (another object of this workspace: 1 part: lid; box 40 x 20 x 5 mm, exact; its picture is attached below)')
    expect(text).toContain('../base/ (another object of this workspace: not built in this run)')
  })

  it('does not attach a picture that is not one, and says so in the text', async () => {
    const out = await onboardObject(deps(), 'cable-clip', draft({ items: [{ file: 'reference/photo-1.jpg', note: 'desk', image: new Uint8Array([1, 2, 3]) }] }))
    expect(sent[0].blocks.map((b) => b.type)).toEqual(['text'])
    expect(out.prompt).toContain('(not attached: read reference/photo-1.jpg)')
  })

  it('goes on when a scan cannot be imported, and says in the text that it could not', async () => {
    const out = await onboardObject(deps({ importScan: async () => { throw new Error('not a mesh') } }), 'cable-clip', draft({ scans: [{ path: '/s/bad.stl', note: 'n' }] }))
    expect(out.sessionId).toBe('sess')
    expect(out.prompt).toContain('- Scan "bad.stl": n. It could not be imported (not a mesh)')
  })

  it('answers with no session, the prompt and the reason when the session cannot be started, and sends nothing', async () => {
    const out = await onboardObject(deps({ start: async () => { throw new Error("cannot start the agent: 'claude' was not found on PATH") } }), 'cable-clip', draft({ scans: [{ path: '/s/desk.stl', note: '' }] }))
    expect(out).toMatchObject({ sessionId: null, problem: "cannot start the agent: 'claude' was not found on PATH" })
    expect(out.prompt).toContain('Scan S1 "desk.stl"')
    expect(out.held).toContain('Scan S1 "desk.stl"')
    expect(sent).toEqual([])
  })

  it('holds the prompt again, with the reason, when the session ends without having taken it up', async () => {
    const out = await onboardObject(deps({ began: async () => ({ began: false as const, why: 'Claude Code stopped (exit code 1): not logged in' }) }), 'cable-clip', draft())
    expect(out).toMatchObject({ sessionId: 'sess', problem: 'Claude Code stopped (exit code 1): not logged in' })
    expect(out.held).toContain('This is a new object, cable-clip')
    const fine = await onboardObject(deps({ began: async () => ({ began: true as const }) }), 'cable-clip', draft())
    expect(fine.problem).toBeUndefined()
  })

  it('keeps the session and the prompt, and says why, when the agent has no chat to send it to', async () => {
    const out = await onboardObject(deps({ start: async () => ({ sessionId: 'term', view: 'terminal' }) }), 'cable-clip', draft())
    expect(out.sessionId).toBe('term')
    expect(out.problem).toMatch(/chat/)
    expect(sent).toEqual([])
  })

  it('refuses an object that is not of the workspace, or has a session already, and does nothing', async () => {
    await expect(onboardObject(deps(), 'nope', draft({ scans: [{ path: '/s/a.stl', note: '' }] }))).rejects.toThrow(/no object/i)
    await expect(onboardObject(deps({ running: () => true }), 'cable-clip', draft({ scans: [{ path: '/s/a.stl', note: '' }] }))).rejects.toThrow(/session/)
    expect(calls).toEqual([])
    expect(sent).toEqual([])
  })

  it('refuses a draft that is not what it may be, before anything is done', async () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ ...draft(), description: 3 }, /description/],
      [{ ...draft(), items: [{ file: '../../etc/passwd', note: '' }] }, /reference/],
      [{ ...draft(), items: [{ file: 'reference/photo-9.png', note: '' }] }, /not there/],
      [{ ...draft(), items: [{ file: 'reference/photo-1.jpg', note: 5 }] }, /note/],
      [{ ...draft(), scans: [{ path: 'relative.stl', note: '' }] }, /scan/],
      [{ ...draft(), scans: [{ path: '/s/a.txt', note: '' }] }, /scan/],
      [{ ...draft(), scans: Array.from({ length: 5 }, () => ({ path: '/s/a.stl', note: '' })) }, /scans/],
      [{ ...draft(), objects: [{ id: 'nope', note: '' }] }, /nope/],
      [{ ...draft(), objects: [{ id: 'cable-clip', note: '' }] }, /itself/],
      [{ ...draft(), objects: Array.from({ length: 9 }, () => ({ id: 'lid', note: '' })) }, /objects/],
      [null, /draft/]
    ]
    for (const [d, why] of bad) await expect(onboardObject(deps(), 'cable-clip', d as OnboardDraft), JSON.stringify(d)).rejects.toThrow(why)
    expect(calls).toEqual([])
  })

  it('lets one call at a time onboard an object: a second, while the first imports, rejects before it imports anything', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const d = deps({ importScan: async (_id, path) => { calls.push(`import ${path}`); await gate; return { id: 'S1', name: 'desk' } } })
    const first = onboardObject(d, 'cable-clip', draft({ scans: [{ path: '/s/desk.stl', note: '' }] }))
    await expect(onboardObject(d, 'cable-clip', draft({ scans: [{ path: '/s/desk.stl', note: '' }] }))).rejects.toThrow(/already/)
    release()
    expect((await first).sessionId).toBe('sess')
    expect(calls.filter((c) => c.startsWith('import'))).toHaveLength(1)
    expect(sent).toHaveLength(1)
    // And once it ended, the object may be onboarded again (a rejected call frees it too).
    await expect(onboardObject(deps({ start: async () => { throw new Error('no') } }), 'cable-clip', draft())).resolves.toMatchObject({ sessionId: null })
    await expect(onboardObject(deps(), 'cable-clip', draft({ description: 3 as never }))).rejects.toThrow()
    await expect(onboardObject(deps(), 'cable-clip', draft())).resolves.toMatchObject({ sessionId: 'sess' })
  })

  it('checks every note and every scan path before it imports anything', async () => {
    const long = 'x'.repeat(2001)
    const bad: Array<[Partial<OnboardDraft>, RegExp]> = [
      [{ scans: [{ path: '/s/a.stl', note: '' }, { path: '/s/b.stl', note: long }] }, /note/],
      [{ scans: [{ path: '/s/a.stl', note: '' }, { path: '/s/b\n- injected.stl', note: '' }] }, /scan/],
      [{ scans: [{ path: '/s/a.stl', note: '' }], items: [{ file: 'reference/photo-1.jpg', note: long }] }, /note/],
      [{ scans: [{ path: '/s/a.stl', note: '' }], objects: [{ id: 'lid', note: long }] }, /note/]
    ]
    for (const [over, why] of bad) await expect(onboardObject(deps(), 'cable-clip', draft(over)), JSON.stringify(over)).rejects.toThrow(why)
    expect(calls).toEqual([])
  })

  it('refuses the same file, scan or object twice', async () => {
    const photo = { file: 'reference/photo-1.jpg', note: '' }
    await expect(onboardObject(deps(), 'cable-clip', draft({ items: [photo, photo] }))).rejects.toThrow(/twice/)
    await expect(onboardObject(deps(), 'cable-clip', draft({ scans: [{ path: '/s/a.stl', note: '' }, { path: '/s/a.stl', note: '' }] }))).rejects.toThrow(/twice/)
    await expect(onboardObject(deps(), 'cable-clip', draft({ objects: [{ id: 'lid', note: '' }, { id: 'lid', note: '' }] }))).rejects.toThrow(/twice/)
    expect(calls).toEqual([])
  })

  it('keeps the session and the prompt, and says why, when the prompt cannot be sent', async () => {
    const out = await onboardObject(deps({ prompt: () => { throw new Error('This session has ended') } }), 'cable-clip', draft())
    expect(out).toMatchObject({ sessionId: 'sess', problem: 'This session has ended' })
    expect(out.prompt).toContain('This is a new object')
  })
})

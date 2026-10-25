import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CreateRequest } from '../../shared/bridge'
import { createObject, readPhoto, sweepStaleNew } from './create'
import template from './template.py.txt?raw'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 9, 9])

let base: string
let ws: string
let files: string

/** Every file and folder under `dir`, relative, sorted. */
function tree(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    out.push(prefix + entry.name + (entry.isDirectory() ? '/' : ''))
    if (entry.isDirectory()) out.push(...tree(join(dir, entry.name), prefix + entry.name + '/'))
  }
  return out.sort()
}

function request(over: Partial<CreateRequest> = {}): CreateRequest {
  return { name: 'cable-clip', description: 'A clip for a 6 mm cable.', photos: [], doodles: [], scans: [], objects: [], ...over }
}

const make = (req: CreateRequest, objects: string[] = [], hooks?: Parameters<typeof createObject>[1]['hooks']) => createObject(req, { root: ws, objects, hooks })

beforeEach(() => {
  base = mkdtempSync(join(realpathSync(tmpdir()), 'torno-create-'))
  ws = join(base, 'ws')
  files = join(base, 'files')
  mkdirSync(ws)
  mkdirSync(files)
  mkdirSync(join(ws, 'lid'))
  writeFileSync(join(ws, 'lid', 'lid.py'), '# lid\n')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('creating an object', () => {
  it('writes the template and the brief, and nothing else, when there is nothing to copy', async () => {
    expect(await make(request())).toEqual({ objectId: 'cable-clip' })
    expect(tree(join(ws, 'cable-clip'))).toEqual(['brief.md', 'cable_clip.py'])
    expect(readFileSync(join(ws, 'cable-clip', 'cable_clip.py'), 'utf8')).toBe(template)
    expect(readFileSync(join(ws, 'cable-clip', 'brief.md'), 'utf8')).toBe('# cable-clip\n\nA clip for a 6 mm cable.\n')
    expect(tree(ws)).toEqual(['cable-clip/', 'cable-clip/brief.md', 'cable-clip/cable_clip.py', 'lid/', 'lid/lid.py'])
  })

  it('copies photos and doodles in the order given and lists every item in the brief, in order', async () => {
    writeFileSync(join(files, 'a.PNG'), PNG)
    writeFileSync(join(files, 'b.jpeg'), JPG)
    const scan = join(files, 'part.stl')
    writeFileSync(scan, 'solid')
    await make(
      request({
        description: '  A clip.\n\nSecond paragraph.  ',
        photos: [
          { path: join(files, 'b.jpeg'), note: 'the desk edge' },
          { path: join(files, 'a.PNG'), note: '' }
        ],
        doodles: [{ png: PNG, note: 'the shape,\nroughly' }],
        scans: [{ path: scan, note: 'the old clip' }],
        objects: [{ id: 'lid', note: 'mounts on this' }]
      }),
      ['lid']
    )
    const dir = join(ws, 'cable-clip')
    expect(tree(dir)).toEqual(['brief.md', 'cable_clip.py', 'reference/', 'reference/doodle-1.png', 'reference/photo-1.jpeg', 'reference/photo-2.png'])
    expect([...readFileSync(join(dir, 'reference', 'photo-1.jpeg'))]).toEqual([...JPG])
    expect([...readFileSync(join(dir, 'reference', 'photo-2.png'))]).toEqual([...PNG])
    expect([...readFileSync(join(dir, 'reference', 'doodle-1.png'))]).toEqual([...PNG])
    expect(readFileSync(join(dir, 'brief.md'), 'utf8')).toBe(
      [
        '# cable-clip',
        '',
        'A clip.\n\nSecond paragraph.',
        '',
        '## References',
        '',
        '- reference/photo-1.jpeg: the desk edge',
        '- reference/photo-2.png',
        '- reference/doodle-1.png: the shape, roughly',
        `- scan ${scan}: the old clip`,
        '- ../lid/: mounts on this',
        ''
      ].join('\n')
    )
  })

  it('leaves no temp folder, and the workspace lists nothing before the rename', async () => {
    let seen: string[] = []
    await make(request(), [], {
      beforeRename: (temp) => {
        seen = readdirSync(ws)
        expect(tree(temp)).toEqual(['brief.md', 'cable_clip.py'])
      }
    })
    expect(seen.filter((n) => !n.startsWith('.'))).toEqual(['lid'])
    expect(seen.some((n) => n.startsWith('.cable-clip.torno-new-'))).toBe(true)
    expect(readdirSync(ws).sort()).toEqual(['cable-clip', 'lid'])
  })

  it('refuses a name that is no good, or there already in any case, and writes nothing', async () => {
    for (const name of ['', '../x', 'a/b', '.x', 'class', 'LID', 'common']) {
      await expect(make(request({ name }))).rejects.toThrow()
    }
    expect(readdirSync(ws)).toEqual(['lid'])
    expect(readFileSync(join(ws, 'lid', 'lid.py'), 'utf8')).toBe('# lid\n')
  })

  it('refuses a folder with no model but something in it, or a plain file, of the same name', async () => {
    mkdirSync(join(ws, 'full'))
    writeFileSync(join(ws, 'full', 'x.txt'), 'x')
    writeFileSync(join(ws, 'notes'), 'x')
    await expect(make(request({ name: 'full' }))).rejects.toThrow(/there already/)
    await expect(make(request({ name: 'Notes' }))).rejects.toThrow(/there already/)
    expect(readdirSync(ws).sort()).toEqual(['full', 'lid', 'notes'])
  })

  it('takes an empty folder of the name as free (a crash left it between the claim and the rename)', async () => {
    mkdirSync(join(ws, 'cable-clip'))
    expect(await make(request())).toEqual({ objectId: 'cable-clip' })
    expect(tree(join(ws, 'cable-clip'))).toEqual(['brief.md', 'cable_clip.py'])
    expect(readdirSync(ws).sort()).toEqual(['cable-clip', 'lid'])
  })

  it('does not take an empty folder as free in another case, or a link to one, and leaves an empty folder it failed on', async () => {
    mkdirSync(join(ws, 'Other'))
    await expect(make(request({ name: 'other' }))).rejects.toThrow(/there already/)
    mkdirSync(join(base, 'elsewhere'))
    symlinkSync(join(base, 'elsewhere'), join(ws, 'linked'))
    await expect(make(request({ name: 'linked' }))).rejects.toThrow(/there already/)
    expect(readdirSync(join(base, 'elsewhere'))).toEqual([])
    mkdirSync(join(ws, 'cable-clip'))
    await expect(make(request({ photos: [{ path: join(files, 'missing.png'), note: '' }] }))).rejects.toThrow(/not there/)
    expect(readdirSync(join(ws, 'cable-clip'))).toEqual([])
  })

  it('refuses the scan path that has a line break, and writes it into the brief as it is otherwise', async () => {
    await expect(make(request({ scans: [{ path: '/x/a\n- ../lid/: injected.stl', note: '' }] }))).rejects.toThrow(/scan/)
    await expect(make(request({ scans: [{ path: '/x/a\r.stl', note: '' }] }))).rejects.toThrow(/scan/)
    expect(readdirSync(ws)).toEqual(['lid'])
  })

  it('refuses a description that is empty, and items beyond the caps', async () => {
    await expect(make(request({ description: '  \n' }))).rejects.toThrow(/what it is/i)
    const photo = (i: number) => ({ path: join(files, `p${i}.png`), note: '' })
    await expect(make(request({ photos: Array.from({ length: 13 }, (_, i) => photo(i)) }))).rejects.toThrow(/photos/)
    await expect(make(request({ doodles: Array.from({ length: 7 }, () => ({ png: PNG, note: '' })) }))).rejects.toThrow(/doodles/)
    await expect(make(request({ scans: Array.from({ length: 5 }, () => ({ path: '/x/a.stl', note: '' })) }))).rejects.toThrow(/scans/)
    await expect(make(request({ objects: Array.from({ length: 9 }, () => ({ id: 'lid', note: '' })) }), ['lid'])).rejects.toThrow(/projects/)
    expect(readdirSync(ws)).toEqual(['lid'])
  })

  it('checks every note and refuses a file given twice before it makes anything, the photos last of all', async () => {
    writeFileSync(join(files, 'a.png'), PNG)
    const a = { path: join(files, 'a.png'), note: '' }
    const seen: string[] = []
    const hooks = { beforeRename: (t: string) => void seen.push(t) }
    const long = 'x'.repeat(2001)
    await expect(make(request({ photos: [a, { ...a }] }), [], hooks)).rejects.toThrow(/twice/)
    await expect(make(request({ photos: [{ ...a, note: long }] }), [], hooks)).rejects.toThrow(/note/)
    await expect(make(request({ doodles: [{ png: PNG, note: long }] }), [], hooks)).rejects.toThrow(/note/)
    await expect(make(request({ scans: [{ path: '/s/a.stl', note: long }] }), [], hooks)).rejects.toThrow(/note/)
    await expect(make(request({ objects: [{ id: 'lid', note: long }] }), ['lid'], hooks)).rejects.toThrow(/note/)
    await expect(make(request({ scans: [{ path: '/s/a.stl', note: '' }, { path: '/s/a.stl', note: '' }] }), [], hooks)).rejects.toThrow(/twice/)
    await expect(make(request({ objects: [{ id: 'lid', note: '' }, { id: 'lid', note: '' }] }), ['lid'], hooks)).rejects.toThrow(/twice/)
    expect(seen).toEqual([])
    // A note is 2,000 characters after it is folded to one line: this one is longer before, not after.
    await make(request({ photos: [{ ...a, note: `${'x '.repeat(900)}\n\n\n    ${'y'.repeat(100)}` }] }), [], hooks)
    expect(seen).toHaveLength(1)
  })

  it('writes a scan under the home folder with ~', async () => {
    const home = homedir()
    await make(request({ scans: [{ path: join(home, 'Downloads', 'desk.stl'), note: '' }, { path: '/mnt/scans/b.stl', note: '' }] }))
    const brief = readFileSync(join(ws, 'cable-clip', 'brief.md'), 'utf8')
    expect(brief).toContain('- scan ~/Downloads/desk.stl\n')
    expect(brief).toContain('- scan /mnt/scans/b.stl\n')
    expect(brief).not.toContain(home)
  })

  it('refuses an object that is not in the workspace, and a scan of a format scans do not have', async () => {
    await expect(make(request({ objects: [{ id: 'nope', note: '' }] }), ['lid'])).rejects.toThrow(/nope/)
    await expect(make(request({ objects: [{ id: '../x', note: '' }] }), ['lid'])).rejects.toThrow()
    await expect(make(request({ scans: [{ path: join(files, 'x.exe'), note: '' }] }))).rejects.toThrow(/scan/)
    await expect(make(request({ scans: [{ path: 'relative.stl', note: '' }] }))).rejects.toThrow(/scan/)
    expect(readdirSync(ws)).toEqual(['lid'])
  })

  describe('reading a photo for the window (its thumbnail, its scaled copy)', () => {
    it('gives the bytes of a plain image file', async () => {
      writeFileSync(join(files, 'a.PNG'), PNG)
      expect(new Uint8Array(await readPhoto(join(files, 'a.PNG')))).toEqual(PNG)
    })
    it('refuses a link, a folder, a file that is no image by its name, a relative path, one over 25 MB', async () => {
      writeFileSync(join(files, 'real.png'), PNG)
      symlinkSync(join(files, 'real.png'), join(files, 'link.png'))
      mkdirSync(join(files, 'dir.png'))
      writeFileSync(join(files, 'notes.txt'), 'x')
      writeFileSync(join(files, 'big.png'), PNG)
      truncateSync(join(files, 'big.png'), 25 * 1024 * 1024 + 1)
      for (const path of [join(files, 'link.png'), join(files, 'dir.png'), join(files, 'notes.txt'), 'real.png', join(files, 'big.png'), join(files, 'none.png')]) await expect(readPhoto(path)).rejects.toThrow()
    })
  })

  describe('a photo that cannot be taken', () => {
    const attempt = async (path: string) => {
      writeFileSync(join(files, 'good.png'), PNG)
      await expect(make(request({ photos: [{ path: join(files, 'good.png'), note: '' }, { path, note: '' }] }))).rejects.toThrow()
      // The first photo was copied into the temp folder before the second was found wanting: all of it is gone.
      expect(readdirSync(ws)).toEqual(['lid'])
    }

    it('is missing', () => attempt(join(files, 'missing.png')))
    it('is a link', async () => {
      writeFileSync(join(files, 'real.png'), PNG)
      symlinkSync(join(files, 'real.png'), join(files, 'link.png'))
      await attempt(join(files, 'link.png'))
    })
    it('is a folder', async () => {
      mkdirSync(join(files, 'dir.png'))
      await attempt(join(files, 'dir.png'))
    })
    it('is a FIFO', async () => {
      execFileSync('mkfifo', [join(files, 'pipe.png')])
      await attempt(join(files, 'pipe.png'))
    })
    it('is over 25 MB (not read whole)', async () => {
      const big = join(files, 'big.png')
      writeFileSync(big, PNG)
      truncateSync(big, 25 * 1024 * 1024 + 1)
      await attempt(big)
    })
    it('has a name that is no image', async () => {
      writeFileSync(join(files, 'doc.pdf'), PNG)
      await attempt(join(files, 'doc.pdf'))
    })
    it('is not an absolute path', () => attempt('photo.png'))
  })

  it('refuses a doodle that is not a PNG, or too big, and removes what was copied', async () => {
    writeFileSync(join(files, 'good.png'), PNG)
    const photos = [{ path: join(files, 'good.png'), note: '' }]
    await expect(make(request({ photos, doodles: [{ png: JPG, note: '' }] }))).rejects.toThrow(/PNG/)
    await expect(make(request({ photos, doodles: [{ png: new Uint8Array(8 * 1024 * 1024 + 1).fill(1), note: '' }] }))).rejects.toThrow(/8 MB/)
    await expect(make(request({ photos, doodles: [{ png: 'x' as unknown as Uint8Array, note: '' }] }))).rejects.toThrow()
    expect(readdirSync(ws)).toEqual(['lid'])
  })

  it('does not replace a folder that appeared while it worked, and removes its own', async () => {
    await expect(
      make(request(), [], {
        beforeRename: () => {
          mkdirSync(join(ws, 'cable-clip'))
          writeFileSync(join(ws, 'cable-clip', 'mine.txt'), 'theirs')
        }
      })
    ).rejects.toThrow(/there already/)
    expect(readdirSync(ws).sort()).toEqual(['cable-clip', 'lid'])
    expect(readFileSync(join(ws, 'cable-clip', 'mine.txt'), 'utf8')).toBe('theirs')
  })

  it('does not replace an empty folder that appeared while it worked either', async () => {
    await expect(make(request(), [], { beforeRename: () => mkdirSync(join(ws, 'cable-clip')) })).rejects.toThrow(/there already/)
    expect(existsSync(join(ws, 'cable-clip', 'cable_clip.py'))).toBe(false)
    expect(readdirSync(ws).filter((n) => n.startsWith('.'))).toEqual([])
  })

  it('removes the temp folder when a hook fails mid-way', async () => {
    await expect(make(request(), [], { beforeRename: () => { throw new Error('disk full') } })).rejects.toThrow(/disk full/)
    expect(readdirSync(ws)).toEqual(['lid'])
  })
})

describe('sweeping what a crash left', () => {
  const stale = '.cable-clip.torno-new-0123456789ab'

  it('removes the hidden folders older than this run, with what is in them, and nothing else', () => {
    mkdirSync(join(ws, stale, 'reference'), { recursive: true })
    mkdirSync(join(ws, '.fresh.torno-new-0123456789ab'))
    mkdirSync(join(ws, '.odd.torno-new-xyz'))
    mkdirSync(join(ws, 'visible.torno-new-0123456789ab'))
    mkdirSync(join(ws, '.hidden'))
    for (const name of ['.odd.torno-new-xyz', 'visible.torno-new-0123456789ab', '.hidden']) utimesSync(join(ws, name), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
    const hourAgo = new Date(Date.now() - 3_600_000)
    utimesSync(join(ws, stale), hourAgo, hourAgo)
    sweepStaleNew(ws, Date.now())
    expect(readdirSync(ws).sort()).toEqual(['.fresh.torno-new-0123456789ab', '.hidden', '.odd.torno-new-xyz', 'lid', 'visible.torno-new-0123456789ab'])
  })

  it('leaves a folder that holds files in reference/ (doodles that exist nowhere else), and removes one with none', () => {
    const kept = '.kept.torno-new-0123456789ab'
    mkdirSync(join(ws, kept, 'reference'), { recursive: true })
    writeFileSync(join(ws, kept, 'reference', 'doodle-1.png'), PNG)
    mkdirSync(join(ws, stale, 'reference'), { recursive: true })
    writeFileSync(join(ws, stale, 'brief.md'), 'x')
    const hourAgo = new Date(Date.now() - 3_600_000)
    for (const name of [kept, stale]) utimesSync(join(ws, name), hourAgo, hourAgo)
    sweepStaleNew(ws, Date.now())
    expect(readdirSync(ws).sort()).toEqual([kept, 'lid'])
    expect(existsSync(join(ws, kept, 'reference', 'doodle-1.png'))).toBe(true)
  })

  it('removes none that is under 10 minutes old, whenever this run began', () => {
    mkdirSync(join(ws, stale))
    const young = new Date(Date.now() - 9 * 60_000)
    utimesSync(join(ws, stale), young, young)
    sweepStaleNew(ws, Date.now())
    expect(readdirSync(ws)).toContain(stale)
    const old = new Date(Date.now() - 11 * 60_000)
    utimesSync(join(ws, stale), old, old)
    sweepStaleNew(ws, Date.now())
    expect(readdirSync(ws)).not.toContain(stale)
  })

  it('never follows a link: one named like a folder of ours is left alone, and so is what it leads to', () => {
    mkdirSync(join(base, 'precious'))
    writeFileSync(join(base, 'precious', 'keep.txt'), 'keep')
    symlinkSync(join(base, 'precious'), join(ws, stale))
    sweepStaleNew(ws, Date.now())
    expect(readFileSync(join(base, 'precious', 'keep.txt'), 'utf8')).toBe('keep')
    expect(readdirSync(ws)).toContain(stale)
  })

  it('does not fail on a workspace that is not there', () => {
    expect(() => sweepStaleNew(join(base, 'nowhere'), Date.now())).not.toThrow()
  })
})

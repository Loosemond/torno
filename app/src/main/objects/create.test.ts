import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CreateRequest } from '../../shared/bridge'
import { createObject } from './create'
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

  it('refuses a folder with no model, or a plain file, of the same name', async () => {
    mkdirSync(join(ws, 'empty'))
    writeFileSync(join(ws, 'notes'), 'x')
    await expect(make(request({ name: 'empty' }))).rejects.toThrow(/there already/)
    await expect(make(request({ name: 'Notes' }))).rejects.toThrow(/there already/)
    expect(readdirSync(ws).sort()).toEqual(['empty', 'lid', 'notes'])
  })

  it('refuses a description that is empty, and items beyond the caps', async () => {
    await expect(make(request({ description: '  \n' }))).rejects.toThrow(/what it is/i)
    const photo = (i: number) => ({ path: join(files, `p${i}.png`), note: '' })
    await expect(make(request({ photos: Array.from({ length: 13 }, (_, i) => photo(i)) }))).rejects.toThrow(/photos/)
    await expect(make(request({ doodles: Array.from({ length: 7 }, () => ({ png: PNG, note: '' })) }))).rejects.toThrow(/doodles/)
    await expect(make(request({ scans: Array.from({ length: 5 }, () => ({ path: '/x/a.stl', note: '' })) }))).rejects.toThrow(/scans/)
    await expect(make(request({ objects: Array.from({ length: 9 }, () => ({ id: 'lid', note: '' })) }), ['lid'])).rejects.toThrow(/objects/)
    expect(readdirSync(ws)).toEqual(['lid'])
  })

  it('refuses an object that is not in the workspace, and a scan of a format scans do not have', async () => {
    await expect(make(request({ objects: [{ id: 'nope', note: '' }] }), ['lid'])).rejects.toThrow(/nope/)
    await expect(make(request({ objects: [{ id: '../x', note: '' }] }), ['lid'])).rejects.toThrow()
    await expect(make(request({ scans: [{ path: join(files, 'x.exe'), note: '' }] }))).rejects.toThrow(/scan/)
    await expect(make(request({ scans: [{ path: 'relative.stl', note: '' }] }))).rejects.toThrow(/scan/)
    expect(readdirSync(ws)).toEqual(['lid'])
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

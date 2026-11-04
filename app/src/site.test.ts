import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs script, without types
import { COPIED } from '../scripts/build-site.mjs'

// The landing page at torno.luisg.me (site/index.html): every local address is a file in git or one that
// app/scripts/build-site.mjs (or build-manual.mjs, for manual/) copies in the Pages build, nothing is loaded
// from another host, and motion is reduced when asked.
const root = resolve(__dirname, '../..')
const site = join(root, 'site')
const html = readFileSync(join(site, 'index.html'), 'utf8')
const css = readFileSync(join(site, 'assets/site.css'), 'utf8')
const copied = COPIED as Record<string, string>

const attrs = (re: RegExp) => [...html.matchAll(re)].map((m) => m[1])
const loaded = [...attrs(/\b(?:src|poster|srcset)="([^"]+)"/g), ...attrs(/<link\b[^>]*\bhref="([^"]+)"/g)]
const links = attrs(/<a\b[^>]*\bhref="([^"]+)"/g)

describe('site/index.html', () => {
  it('loads nothing from another host', () => {
    expect(loaded.filter((u) => /^(https?:)?\/\//.test(u))).toEqual([])
    expect(css).not.toMatch(/url\(\s*['"]?(https?:)?\/\//)
    expect(css).not.toMatch(/@import/)
  })

  it('names only files that are there or that the Pages build copies', () => {
    const local = [...loaded, ...links, ...[...css.matchAll(/url\(([^)]+)\)/g)].map((m) => `assets/${m[1]}`)]
      .filter((u) => !/^([a-z]+:|\/\/|#)/.test(u))
      .map((u) => u.split('#')[0].replace(/\/$/, '/index.html'))
    expect(local.length).toBeGreaterThan(10)
    for (const path of local) {
      if (path.startsWith('manual/')) continue // build-manual.mjs writes manual/index.html
      const there = existsSync(join(site, path)) || path in copied
      expect(there, path).toBe(true)
    }
    for (const from of Object.values(copied)) expect(existsSync(join(root, from)), from).toBe(true)
  })

  it('has no live project, and has the two calls to action', () => {
    expect(links.filter((u) => /demo\//.test(u))).toEqual([])
    expect(links).toContain('#run')
    expect(links.filter((u) => u === 'https://github.com/luisg0nc/torno').length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('Collaborate on GitHub')
    expect(links).toContain('https://github.com/luisg0nc/torno/blob/main/CONTRIBUTING.md')
    expect(links).toContain('https://github.com/luisg0nc/torno/issues')
  })

  it('reduces motion when asked', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
  })
})

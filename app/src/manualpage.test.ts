import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { renderManual, rewriteLink, slug } from '../scripts/manual-page.mjs'

test('relative links of the manual work on the page', () => {
  expect(rewriteLink('../README.md')).toBe('https://github.com/luisg0nc/torno/blob/main/README.md')
  expect(rewriteLink('superpowers/specs/x.md')).toBe('https://github.com/luisg0nc/torno/blob/main/docs/superpowers/specs/x.md')
  expect(rewriteLink('images/loop.svg')).toBe('images/loop.svg')
  expect(rewriteLink('manual.md#scans')).toBe('#scans')
  expect(rewriteLink('#scans')).toBe('#scans')
  expect(rewriteLink('https://docs.astral.sh/uv/')).toBe('https://docs.astral.sh/uv/')
})

test('headings get the ids GitHub gives them, and a contents list', () => {
  expect(slug('Projects and builds')).toBe('projects-and-builds')
  const taken = new Map<string, number>()
  expect([slug('Marks', taken), slug('Marks', taken)]).toEqual(['marks', 'marks-1'])
  const { html, headings } = renderManual('# T\n\n## One\n\n### Two\n\nSee [the readme](../README.md) and [one](manual.md#one).\n')
  expect(headings).toEqual([
    { depth: 2, id: 'one', text: 'One' },
    { depth: 3, id: 'two', text: 'Two' }
  ])
  expect(html).toContain('<h2 id="one">')
  expect(html).toContain('href="https://github.com/luisg0nc/torno/blob/main/README.md"')
  expect(html).toContain('href="#one"')
})

test('every link of the real manual to a heading finds it on the page', () => {
  const markdown = readFileSync(resolve(__dirname, '../../docs/manual.md'), 'utf8')
  const { html } = renderManual(markdown)
  const missing = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]).filter((id) => !html.includes(`id="${id}"`))
  expect(missing).toEqual([])
})

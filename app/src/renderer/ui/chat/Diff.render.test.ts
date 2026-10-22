import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Diff } from './Diff'
import { diffText } from './diff'

it('draws a line removed in a <del> and a line added in an <ins>, each with its sign, as text and never as HTML', () => {
  const html = renderToStaticMarkup(createElement(Diff, { hunks: [{ title: 'Edit 1 of 2', ...diffText('keep\nWALL = <b>2</b>', 'keep\nWALL = 3') }] }))
  expect(html.replace(/<[^>]*>/g, '')).toContain('Edit 1 of 2')
  expect(html).toMatch(/<del[^>]*>WALL = &lt;b&gt;2&lt;\/b&gt;<\/del>/)
  expect(html).toMatch(/<ins[^>]*>WALL = 3<\/ins>/)
  expect(html).toMatch(/data-kind="removed"[^>]*><span class="diff-sign" aria-hidden="true">−<\/span>/)
  expect(html).toMatch(/data-kind="added"[^>]*><span class="diff-sign" aria-hidden="true">\+<\/span>/)
  expect(html).not.toContain('<b>')
})

it('says when a text is too long to compare, and when nothing differs', () => {
  const many = Array.from({ length: 401 }, (_, i) => `l${i}`).join('\n')
  expect(renderToStaticMarkup(createElement(Diff, { hunks: [diffText(many, 'x')] }))).toContain('Too long to compare')
  expect(renderToStaticMarkup(createElement(Diff, { hunks: [diffText('a', 'a')] }))).toContain('No change')
})

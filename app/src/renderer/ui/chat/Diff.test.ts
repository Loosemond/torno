import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Diff } from './Diff'
import { diffText } from './lineDiff'

it('draws a line removed in a <del> and a line added in an <ins>, each with its sign, as text and never as HTML', () => {
  const html = renderToStaticMarkup(createElement(Diff, { hunks: [{ title: 'Edit 1 of 2', ...diffText('keep\nWALL = <b>2</b>', 'keep\nWALL = 3') }] }))
  expect(html.replace(/<[^>]*>/g, '')).toContain('Edit 1 of 2')
  expect(html).toMatch(/<del[^>]*>WALL = &lt;b&gt;2&lt;\/b&gt;<\/del>/)
  expect(html).toMatch(/<ins[^>]*>WALL = 3<\/ins>/)
  expect(html).toMatch(/data-kind="removed"[^>]*><span class="diff-sign" aria-hidden="true">−<\/span>/)
  expect(html).toMatch(/data-kind="added"[^>]*><span class="diff-sign" aria-hidden="true">\+<\/span>/)
  expect(html).not.toContain('<b>')
})

const text = (html: string): string => html.replace(/<[^>]*>/g, '')

it('says when a text is too long to compare, and still shows what was removed, and when nothing differs', () => {
  const many = Array.from({ length: 401 }, (_, i) => `l${i}`).join('\n')
  const html = renderToStaticMarkup(createElement(Diff, { hunks: [diffText(many, 'x')] }))
  expect(text(html)).toContain('Too long to compare')
  expect(html).toContain('<del>l400</del>')
  expect(html).toContain('<ins>x</ins>')
  expect(text(renderToStaticMarkup(createElement(Diff, { hunks: [diffText('a', 'a')] })))).toContain('No change')
})

it('says an edit replaces every match, and that its lines are the edit\'s and not the file\'s', () => {
  const html = renderToStaticMarkup(createElement(Diff, { hunks: [{ ...diffText('a', 'b'), everywhere: true }, diffText('c', 'd')] }))
  expect(text(html).match(/Replaces every match in the file/g)).toHaveLength(1)
  expect(text(html).match(/Lines of the edit, not of the file: where it lands is not shown/g)).toHaveLength(1)
})

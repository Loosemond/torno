import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Markdown, parseMarkdown } from './markdown'

// What the object has is the window's store, which a static render does not see: these are the refs it has.
const HAS = new Set(['M4', 'lid/F12', 'r3'])
vi.mock('./refs', () => ({ refInfo: (_state: unknown, value: string) => ({ kind: 'mark', live: false, lights: [], plain: !HAS.has(value), title: value }) }))

const html = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }))

describe('the markdown of the agent\'s text', () => {
  it('reads paragraphs, a blank line apart; a line broken inside one stays in it', () => {
    expect(html('one\ntwo\n\nthree')).toBe('<div class="md"><p>one two</p><p>three</p></div>')
  })

  it('reads headings as bold lines of the same size, at every depth', () => {
    const out = html('# Title\n### Deeper')
    expect(out).toContain('<p class="md-heading"><strong>Title</strong></p>')
    expect(out).toContain('<p class="md-heading"><strong>Deeper</strong></p>')
    expect(out).not.toMatch(/<h\d/)
  })

  it('reads unordered and ordered lists, nested by indent', () => {
    expect(html('- a\n- b\n  - c\n  - d\n- e')).toBe('<div class="md"><ul><li>a</li><li>b<ul><li>c</li><li>d</li></ul></li><li>e</li></ul></div>')
    expect(html('1. one\n2. two\n   - x')).toBe('<div class="md"><ol><li>one</li><li>two<ul><li>x</li></ul></li></ol></div>')
  })

  it('reads a fenced code block as monospace text, and keeps what is in it as it is', () => {
    const out = html('before\n```python\nx = **2**\n  y = M4\n```\nafter')
    expect(out).toContain('<pre class="md-code"><code>x = **2**\n  y = M4</code></pre>')
    expect(out).not.toContain('<strong>')
    expect(out).not.toContain('data-ref')
    expect(out).toContain('<p>after</p>')
  })

  it('keeps a fence that is never closed (a text still streaming) as code to the end', () => {
    expect(html('```\nsolid = 1')).toContain('<pre class="md-code"><code>solid = 1</code></pre>')
  })

  it('reads inline code, bold and italic, and leaves a snake_case name alone', () => {
    const out = html('a `b_c` and **bold** and *it* and snake_case_name and _under_')
    expect(out).toContain('<code class="md-inline">b_c</code>')
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toContain('<em>it</em>')
    expect(out).toContain('snake_case_name')
    expect(out).toContain('<em>under</em>')
  })

  it('shows a link as its text with the address in the monospace face, never as something to click', () => {
    const out = html('see [the docs](https://example.com/a) now')
    expect(out).toContain('the docs')
    expect(out).toContain('<span class="md-url num">https://example.com/a</span>')
    expect(out).not.toContain('<a')
    expect(out).not.toContain('href')
  })

  it('reads a table of pipes', () => {
    const out = html('| Part | Mass |\n| --- | ---: |\n| lid | 12 g |\n| tub | 40 g |')
    expect(out).toContain('<table class="md-table">')
    expect(out).toMatch(/<th>Part<\/th><th>Mass<\/th>/)
    expect(out).toContain('<td>lid</td>')
    expect(out.match(/<tr>/g)).toHaveLength(3)
  })

  it('reads a quote and a rule', () => {
    expect(html('> said so')).toContain('<blockquote class="md-quote">said so</blockquote>')
    expect(html('a\n\n---\n\nb')).toContain('<hr class="md-rule"/>')
  })

  it('never draws html: a script in the text is text', () => {
    const out = html('<script>alert(1)</script> and <img src=x onerror=boom()>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;script&gt;alert(<span class="num">1</span>)&lt;/script&gt;')
    expect(html('```\n<script>x</script>\n```')).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(html('[x](javascript:alert(1))')).not.toContain('href')
  })

  it('draws a ref in the text as a chip, but not inside code', () => {
    const out = html('M4 sits on lid/F12, see `M4` and r3.')
    expect(out.match(/data-ref="[^"]+"/g)).toEqual(['data-ref="M4"', 'data-ref="lid/F12"', 'data-ref="r3"'])
    expect(html('```\nM4\n```')).not.toContain('data-ref')
    expect(html('**M4 in bold**')).toContain('data-ref="M4"')
  })

  it('leaves what is no ref of this object as text: an M3 screw, a build not made, a part it does not have', () => {
    const out = html('an M3 clearance hole, M4 and r9 and cap/F1')
    expect(out.match(/data-ref="[^"]+"/g)).toEqual(['data-ref="M4"'])
    expect(out).toContain('<span class="num">M3</span>')
    expect(out).toContain('<span class="num">r9</span>')
  })

  it('sets numbers in the monospace face', () => {
    expect(html('wall of 2.5 mm')).toContain('<span class="num">2.5</span>')
  })

  it('holds a code block of 2,000 lines in one element', () => {
    const body = Array.from({ length: 2000 }, (_, n) => `line ${n}`).join('\n')
    const out = html(`\`\`\`\n${body}\n\`\`\``)
    expect(out.match(/<pre/g)).toHaveLength(1)
    expect(out).toContain('line 1999')
    expect(parseMarkdown(`\`\`\`\n${body}\n\`\`\``)).toHaveLength(1)
  })

  it('survives a long list nested deeper than it makes sense to', () => {
    const deep = Array.from({ length: 40 }, (_, n) => `${' '.repeat(n * 2)}- item ${n}`).join('\n')
    expect(html(deep)).toContain('<span class="num">39</span>')
  })

  it('parses what is never closed in no time: a line of unmatched markers is no cost that grows with the square of its length', () => {
    const inputs = ['*a b '.repeat(10_000), '_a '.repeat(17_000), '[a '.repeat(17_000), `# a${' '.repeat(3000)}x`, 'a'.repeat(50_000), `# ${'#'.repeat(50_000)} x`, `${' '.repeat(50_000)}x`, `| a |\n| ${'- '.repeat(20_000)}`]
    for (const input of inputs) {
      const before = performance.now()
      html(input)
      expect([input.slice(0, 12), performance.now() - before < 50]).toEqual([input.slice(0, 12), true])
    }
  })

  it('draws a line too long to be read for markers as the plain text it is', () => {
    const long = `${'word '.repeat(1000)}**not bold**`
    expect(html(long)).not.toContain('<strong>')
    expect(html(long)).toContain('**not bold**')
  })

  it('keeps a heading\'s closing hashes out of it', () => {
    expect(html('## Title ##')).toContain('<strong>Title</strong>')
  })
})


import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

// What the stylesheets are held to beyond their tokens' contrasts (`shared/contrast.test.ts`): nothing in the
// window or in an exported page animates without end, and no text is made fainter than its colour by `opacity`.

const SHEETS = { 'app.css': resolve(__dirname, 'app.css'), 'tokens.css': resolve(__dirname, 'tokens.css'), 'page.css': resolve(__dirname, '../../export/page.css') }

/** Every rule of a stylesheet, flat: its selector (with the at-rules it is under) and its declarations. Comments are taken out first. */
export function rules(css: string): Array<{ selector: string; body: string }> {
  const found: Array<{ selector: string; body: string }> = []
  const walk = (text: string, under: string): void => {
    let at = 0
    while (at < text.length) {
      const open = text.indexOf('{', at)
      if (open < 0) return
      let depth = 1
      let close = open + 1
      while (close < text.length && depth > 0) {
        if (text[close] === '{') depth += 1
        else if (text[close] === '}') depth -= 1
        close += 1
      }
      const selector = text.slice(at, open).trim()
      const body = text.slice(open + 1, close - 1)
      if (selector.startsWith('@media') || selector.startsWith('@supports') || selector.startsWith('@container')) walk(body, `${under}${selector} `)
      else found.push({ selector: `${under}${selector}`.replace(/\s+/g, ' '), body })
      at = close
    }
  }
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), '')
  return found
}

it('reads a stylesheet rule by rule, also under an at-rule', () => {
  expect(rules('/* a */ .a, .b { color: red; }\n@media (x) { .c { opacity: 0.5 } }\n@keyframes k { to { opacity: 0 } }')).toEqual([
    { selector: '.a, .b', body: ' color: red; ' },
    { selector: '@media (x) .c', body: ' opacity: 0.5 ' },
    { selector: '@keyframes k', body: ' to { opacity: 0 } ' }
  ])
})

it('animates nothing without end: a dot that pulses for ever keeps a window drawing that nobody looks at', () => {
  // Found in the hidden window (the sweep's finding 4): 3.4 MB a second while such a dot pulsed. A build's dot
  // beats with the count of its seconds instead (`BuildStatus`), and a session at work has a still one.
  for (const [name, path] of Object.entries(SHEETS)) {
    const css = readFileSync(path, 'utf8')
    for (const { selector, body } of rules(css)) expect([name, selector, /\binfinite\b/.test(body)]).toEqual([name, selector, false])
    // Nor a set of keyframes left for one: every animation there is runs once.
    for (const { selector, body } of rules(css)) {
      const animated = /animation(?:-iteration-count)?\s*:\s*([^;]+)/.exec(body)?.[1] ?? ''
      expect([name, selector, /\b(?:infinite|\d{3,})\b/.test(animated.replace(/\d+m?s/g, ''))]).toEqual([name, selector, false])
    }
  }
})

/** What may be made fainter: something switched off, hidden or not yet there, and things that are no text. */
const MAY_FADE = [
  /:disabled|\[disabled\]|\[data-disabled\]|\[data-hidden\]|\[aria-disabled/,
  // Not text: a swatch of colour, a picture, a dot, a slider's own track.
  /\.swatch\b|\bimg\b|\.status-dot\b|\.dot\b|::-webkit-slider|\.dock-edge\b/
]

it('dims no text by opacity: what is fainter than its token is under the contrast the token was chosen for', () => {
  const found: string[] = []
  for (const [name, path] of Object.entries(SHEETS)) {
    for (const { selector, body } of rules(readFileSync(path, 'utf8'))) {
      if (selector.startsWith('@keyframes')) continue
      for (const match of body.matchAll(/(?:^|[;\s])opacity\s*:\s*([\d.]+)/g)) {
        const value = Number(match[1])
        // Not there at all until it is pointed at (0), or as it is (1): neither is text made faint.
        if (value === 0 || value >= 1) continue
        if (selector.split(',').every((one) => MAY_FADE.some((allowed) => allowed.test(one)))) continue
        found.push(`${name}: ${selector} { opacity: ${match[1]} }`)
      }
    }
  }
  expect(found).toEqual([])
})

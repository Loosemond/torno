import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

/** `--name: value` of a block of CSS, by name. */
const tokens = (css: string): Record<string, string> => Object.fromEntries([...css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
const halves = (css: string): [string, string] => {
  const at = css.indexOf('@media (prefers-color-scheme: dark)')
  return [css.slice(0, at), css.slice(at)]
}

it('uses the tokens of the app, to the value, in light and in dark', () => {
  const app = halves(readFileSync(resolve(__dirname, '../renderer/styles/tokens.css'), 'utf8'))
  const page = halves(readFileSync(resolve(__dirname, 'page.css'), 'utf8'))
  for (const theme of [0, 1]) {
    const [ours, theirs] = [tokens(page[theme]), tokens(app[theme])]
    expect(Object.keys(ours).length).toBeGreaterThan(8)
    for (const [name, value] of Object.entries(ours)) expect([name, value]).toEqual([name, theirs[name]])
  }
  // The page can be switched by hand: the dark values are also under [data-theme="dark"].
  expect(readFileSync(resolve(__dirname, 'page.css'), 'utf8')).toContain(':root[data-theme="dark"]')
})

it('holds the dark values twice to the letter: for a system that asks for dark, and for the switch', () => {
  const css = readFileSync(resolve(__dirname, 'page.css'), 'utf8')
  const system = /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/.exec(css)
  const byHand = /\n:root\[data-theme="dark"\] \{([^}]*)\}/.exec(css)
  expect(system).not.toBeNull()
  expect(byHand).not.toBeNull()
  expect(tokens(byHand![1])).toEqual(tokens(system![1]))
})

it('asks for nothing from anywhere: no url, no import', () => {
  const css = readFileSync(resolve(__dirname, 'page.css'), 'utf8')
  expect(css).not.toMatch(/url\(|@import|https?:/)
})

it('has a viewer that sets text and never markup, and evaluates nothing', () => {
  const dir = resolve(__dirname, 'viewer')
  for (const file of ['main.ts', 'model.ts', 'overlay.ts', 'panel.ts']) {
    const source = readFileSync(resolve(dir, file), 'utf8')
    expect([file, source.match(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|DOMParser|createContextualFragment|srcdoc|fetch\(|XMLHttpRequest|WebSocket|importScripts|localStorage|sessionStorage|cookie/g)]).toEqual([file, null])
  }
})

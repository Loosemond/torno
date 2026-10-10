import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrast } from './contrast'

it('is the ratio WCAG gives', () => {
  expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
  expect(contrast('#ffffff', '#ffffff')).toBe(1)
  expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.478, 2)
  expect(contrast('#22252A', '#F1EFEA')).toBeGreaterThan(12)
})

const css = readFileSync(resolve(__dirname, '../renderer/styles/tokens.css'), 'utf8')
const dark = css.indexOf('@media (prefers-color-scheme: dark)')
const tokens = (block: string): Record<string, string> => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]))

describe.each([['light', tokens(css.slice(0, dark))], ['dark', { ...tokens(css.slice(0, dark)), ...tokens(css.slice(dark)) }]])('%s', (_theme, t) => {
  it('reads: ink and muted text on both grounds, the accent on the panel', () => {
    for (const ground of ['--surface', '--panel']) {
      expect(contrast(t['--ink'], t[ground])).toBeGreaterThanOrEqual(7)
      expect(contrast(t['--muted'], t[ground])).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(t['--accent'], t['--panel'])).toBeGreaterThanOrEqual(4.5)
  })
  it('reads wherever a colour is text: the verdicts on both grounds, what is chosen on its wash, the primary button, the terminal', () => {
    // A verdict is said in words in its colour (the status line, a chip, a card): text, not only a sign.
    for (const name of ['--ok', '--warn', '--fail']) for (const ground of ['--surface', '--panel']) expect([name, ground, contrast(t[name], t[ground]) >= 4.5]).toEqual([name, ground, true])
    // The row that is chosen is the accent on its wash, and ink on it; the primary button the panel's colour on the accent.
    expect(contrast(t['--accent'], t['--accent-wash'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(t['--ink'], t['--accent-wash'])).toBeGreaterThanOrEqual(7)
    expect(contrast(t['--panel'], t['--accent'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(t['--accent'], t['--surface'])).toBeGreaterThanOrEqual(4.5)
    // A mark's number is the panel's colour on the person's red; the three axes are letters beside their fields.
    expect(contrast(t['--panel'], t['--user-mark'])).toBeGreaterThanOrEqual(4.5)
    // The agent's is its own colour on the panel, outlined.
    expect(contrast(t['--agent-mark'], t['--panel'])).toBeGreaterThanOrEqual(4.5)
    for (const name of ['--axis-x', '--axis-y', '--axis-z']) expect([name, contrast(t[name], t['--panel']) >= 4.5]).toEqual([name, true])
    // Whatever an agent's CLI writes is text on the panel, in any of the sixteen colours but the dark theme's black, which is the ground's own.
    const ansi = Object.keys(t).filter((name) => name.startsWith('--ansi-'))
    expect(ansi).toHaveLength(16)
    for (const name of ansi) {
      if (_theme === 'dark' && name === '--ansi-black') continue
      expect([name, contrast(t[name], t['--panel']) >= 4.5]).toEqual([name, true])
    }
  })
  it('keeps the two mark colours for marks: a verdict is a colour of its own, to the eye, in both themes', () => {
    // Not by name only: a failing dimension of the person's has a cross beside a chip in their colour, and the
    // two are told apart (1.5:1 at least between a verdict and the mark colour of its hue).
    expect(contrast(t['--fail'], t['--user-mark'])).toBeGreaterThanOrEqual(1.5)
    expect(contrast(t['--ok'], t['--agent-mark'])).toBeGreaterThanOrEqual(1.5)
    expect(t['--user-mark']).not.toBe(t['--agent-mark'])
    // Nor is an axis a mark's colour: X is no red pencil, Y no agent's green.
    for (const axis of ['--axis-x', '--axis-y', '--axis-z']) for (const mark of ['--user-mark', '--agent-mark']) expect([axis, mark, t[axis] === t[mark]]).toEqual([axis, mark, false])
  })
  it('reads on the wash of the row that is chosen or pointed at: muted words and the three verdicts', () => {
    for (const name of ['--muted', '--ok', '--warn', '--fail']) expect([name, contrast(t[name], t['--accent-wash']) >= 4.5]).toEqual([name, true])
  })
  it('draws a mark\'s line on a casing in the panel\'s colour, against which it reads, and which stands off every part', () => {
    // The pair that is adjacent: the line and its casing.
    for (const mark of ['--user-mark', '--agent-mark']) expect([mark, contrast(t[mark], t['--panel']) >= 3]).toEqual([mark, true])
    // The casing against the parts. In dark it is 3:1 against every one of them. In light the parts are pastels
    // on a near-white panel, and no casing in the panel's colour can be 3:1 against them (2.18 to 3.79): it is
    // held to 2:1 there, which is a visible edge, where the bare line was 1.2 to 2.1.
    const parts = Object.keys(t).filter((name) => /^--part-\d$/.test(name))
    expect(parts).toHaveLength(8)
    for (const part of parts) expect([part, contrast(t['--panel'], t[part]) >= (_theme === 'dark' ? 3 : 2)]).toEqual([part, true])
  })
  it('shows where a list is scrolled to: the thumb of a scrollbar is 3:1 on the panel and on the ground', () => {
    for (const ground of ['--panel', '--surface']) expect([ground, contrast(t['--scroll-thumb'], t[ground]) >= 3]).toEqual([ground, true])
    expect(contrast(t['--scroll-thumb'], t['--panel'])).toBeLessThan(contrast(t['--muted'], t['--panel']))
  })
  it('reads what is selected in the terminal: it is set in ink on the selection, whatever colour it had', () => {
    expect(contrast(t['--ink'], t['--term-selection'])).toBeGreaterThanOrEqual(7)
    const pane = readFileSync(resolve(__dirname, '../renderer/ui/SessionPane.tsx'), 'utf8')
    expect(pane).toContain("selectionForeground: token('--ink')")
    // And the dark theme's black, which is the ground's own, is lifted by the terminal itself wherever it is text.
    expect(pane).toContain('minimumContrastRatio: 4.5')
  })
  it('keeps the letters of the triad readable on the ground of a picture, and the three axes apart from the marks', () => {
    for (const name of ['--axis-x', '--axis-y', '--axis-z']) expect([name, contrast(t[name], t['--surface']) >= 4.5]).toEqual([name, true])
  })
  it('is no amber on near black: the warning of the dark theme is an ochre', () => {
    if (_theme === 'dark') expect(t['--warn']).toBe('#CBAA6A')
  })
  it('shows its marks and its verdicts on the ground, and keeps its hairlines quiet', () => {
    for (const name of ['--user-mark', '--agent-mark', '--ok', '--warn', '--fail']) expect([name, contrast(t[name], t['--surface']) >= 3]).toEqual([name, true])
    const hairline = contrast(t['--hairline'], t['--surface'])
    expect(hairline).toBeGreaterThanOrEqual(1.15)
    expect(hairline).toBeLessThanOrEqual(2)
  })
})

it('has the light tokens written out where no stylesheet is read, as the stylesheet has them', async () => {
  // The viewport's fallback theme, the sheet a section is drawn on for the agent, the window's ground in main, and the exported page.
  const light = tokens(css.slice(0, dark))
  const night = tokens(css.slice(dark))
  const { LIGHT_THEME } = await import('../renderer/viewport/theme')
  const { SHEET } = await import('../renderer/viewport/sectionDrawing')
  expect({ surface: LIGHT_THEME.surface, hairline: LIGHT_THEME.hairline, ink: LIGHT_THEME.ink, muted: LIGHT_THEME.muted, accent: LIGHT_THEME.accent, panel: LIGHT_THEME.panel, user: LIGHT_THEME.user, agent: LIGHT_THEME.agent }).toEqual({
    surface: light['--surface'],
    hairline: light['--hairline'],
    ink: light['--ink'],
    muted: light['--muted'],
    accent: light['--accent'],
    panel: light['--panel'],
    user: light['--user-mark'],
    agent: light['--agent-mark']
  })
  expect(SHEET).toEqual({ paper: light['--surface'], ink: light['--ink'], muted: light['--muted'], hairline: light['--hairline'] })
  const main = readFileSync(resolve(__dirname, '../main/index.ts'), 'utf8')
  expect(main).toContain(`const SURFACE = { light: '${light['--surface']}', dark: '${night['--surface']}' }`)
  const { AXIS_COLOURS } = await import('../renderer/viewport/overlay')
  expect([...AXIS_COLOURS]).toEqual([light['--axis-x'], light['--axis-y'], light['--axis-z']])
  expect([LIGHT_THEME.axisX, LIGHT_THEME.axisY, LIGHT_THEME.axisZ]).toEqual([...AXIS_COLOURS])
  // The terminal's plain white is the muted grey, in light.
  expect(light['--ansi-white']).toBe(light['--muted'])
})

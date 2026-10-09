import { afterEach, describe, expect, it, vi } from 'vitest'
import { chipSize, drawLabels, type LabelStyle } from './overlay'

/** A canvas context that keeps what was drawn on it: each text with how opaque it was, and each stroke with its colour and its moves. */
function recorder() {
  const texts: Array<{ text: string; alpha: number }> = []
  const strokes: Array<{ colour: string; moves: number; lines: number }> = []
  let moves = 0
  let lines = 0
  const ctx = {
    globalAlpha: 1,
    strokeStyle: '',
    fillStyle: '',
    font: '',
    lineWidth: 1,
    save: () => {},
    restore: () => {},
    measureText: (text: string) => ({ width: 7 * text.length }),
    beginPath: () => {
      moves = 0
      lines = 0
    },
    moveTo: () => void (moves += 1),
    lineTo: () => void (lines += 1),
    roundRect: () => {},
    fill: () => {},
    stroke: () => void strokes.push({ colour: ctx.strokeStyle, moves, lines }),
    fillText: (text: string) => void texts.push({ text, alpha: ctx.globalAlpha })
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, strokes }
}

const STYLE: LabelStyle = { user: '#cf3f2c', agent: '#2b8a5c', paper: '#ffffff', surface: '#f4f4f2', ink: '#1c1d1f', fail: '#c0392b', ok: '#2b8a5c' }
const label = (value: { text: string; verdict?: 'pass' | 'fail'; stale?: true }) => ({ id: 'M1', text: 'M1', author: 'user' as const, x: 100, y: 100, visible: true, box: { x: 100, y: 90, w: 90, h: 17 }, value })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the chip of a dimension’s value', () => {
  it('has room for the glyph of its verdict, a tick or a cross, and for none without one', () => {
    const size = chipSize(recorder().ctx, 1)
    const plain = size('M1', { text: '⌀ 8 mm' }).w
    expect(size('M1', { text: '⌀ 8 mm', verdict: 'pass' }).w).toBe(plain + 13)
    expect(size('M1', { text: '⌀ 8 mm', verdict: 'fail' }).w).toBe(plain + 11)
    expect(size('M1', { text: '⌀ 8 mm', stale: true }).w).toBe(plain)
  })

  it('one that fails has a cross after it, in the colour of failure: the ring alone is the colour of the person’s marks', () => {
    const { ctx, strokes } = recorder()
    drawLabels(ctx, [label({ text: '⌀ 8 mm', verdict: 'fail' })], STYLE, 1)
    // Two strokes of a cross: two moves, two lines, drawn at once.
    expect(strokes.filter((s) => s.moves === 2 && s.lines === 2)).toEqual([{ colour: '#c0392b', moves: 2, lines: 2 }])
    const passing = recorder()
    drawLabels(passing.ctx, [label({ text: '⌀ 8 mm', verdict: 'pass' })], STYLE, 1)
    expect(passing.strokes.filter((s) => s.moves === 2)).toEqual([])
    expect(passing.strokes.at(-1)).toEqual({ colour: '#2b8a5c', moves: 1, lines: 2 })
  })

  it('a value of another build is written faint, with neither glyph', () => {
    const { ctx, texts, strokes } = recorder()
    drawLabels(ctx, [label({ text: '⌀ 8 mm', stale: true })], STYLE, 1)
    expect(texts).toEqual([{ text: 'M1', alpha: 1 }, { text: '⌀ 8 mm', alpha: 0.45 }])
    expect(strokes.filter((s) => s.moves > 0)).toEqual([])
    const current = recorder()
    drawLabels(current.ctx, [label({ text: '⌀ 8 mm' })], STYLE, 1)
    expect(current.texts[1]).toEqual({ text: '⌀ 8 mm', alpha: 1 })
  })

  it('reads the colours of the verdicts from the page once, and again when the colours of the labels change', () => {
    let scheme = 'light'
    const read = vi.fn(() => ({ getPropertyValue: (name: string) => `${scheme}${name}` }))
    vi.stubGlobal('document', { documentElement: {} })
    vi.stubGlobal('getComputedStyle', read)
    const { fail: _fail, ok: _ok, ...bare } = STYLE
    const draw = (style: LabelStyle): string => {
      const { ctx, strokes } = recorder()
      drawLabels(ctx, [label({ text: '⌀ 8 mm', verdict: 'fail' })], style, 1)
      return strokes.find((s) => s.moves === 2)!.colour
    }
    expect(draw(bare)).toBe('light--fail')
    expect(draw(bare)).toBe('light--fail')
    expect(read).toHaveBeenCalledTimes(1)
    // The colour scheme changed: the labels are given other colours, and the tokens are read again.
    scheme = 'dark'
    expect(draw({ ...bare, ink: '#eeeeee', paper: '#111111' })).toBe('dark--fail')
    expect(read).toHaveBeenCalledTimes(2)
    // A style that says both is asked nothing of the page.
    expect(draw(STYLE)).toBe('#c0392b')
    expect(read).toHaveBeenCalledTimes(2)
  })
})

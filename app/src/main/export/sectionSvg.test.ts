import { describe, expect, it } from 'vitest'
import type { Sectioned } from '../../shared/geometry'
import type { DimensionMark } from '../../shared/marks'
import { full, niceLength, sectionSvg } from './sectionSvg'

const loop = (points: Array<[number, number]>, area: number) => ({ points, closed: true, area, areaExact: true, deflection: 0.01 })

/** A plate 40 by 30 mm with a 10 mm square hole, cut by z = 5. */
function plate(over: Partial<Sectioned['plane']> = {}, exact = true): Sectioned {
  return {
    plane: { origin: [0, 0, 5], normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0], ...over },
    parts: [
      {
        part: 'plate',
        loops: [
          loop([[-20, -15], [20, -15], [20, 15], [-20, 15]], 1200),
          loop([[-5, -5], [5, -5], [5, 5], [-5, 5]], -100)
        ],
        area: 1100,
        areaExact: exact,
        open: 0,
        how: 'cross-section of the solid'
      }
    ],
    bounds: { min: [-20, -15], max: [20, 15] }
  }
}

const base = { author: 'user', status: 'sent', anchorState: 'ok', layout: 'assembly', revision: 1, createdAt: '2026-10-09T20:00:00.000Z', camera: {} }
function dimension(id: string, points: [[number, number, number], [number, number, number]], extra: Partial<DimensionMark> = {}): DimensionMark {
  return { ...base, id, kind: 'dimension', measure: 'distance', a: { point: points[0], normal: [0, 0, 1], part: 'plate' }, b: { point: points[1], normal: [0, 0, 1], part: 'plate' }, value: 40, measuredRevision: 3, points, verdict: 'pass', expected: 40, ...extra } as unknown as DimensionMark
}

const info = (marks: DimensionMark[] = []) => ({ object: 'plate', layout: 'assembly', revision: 3, date: new Date('2026-11-04T10:00:00Z'), marks })

/** The numbers of a path's `d`, as pairs. */
function pairs(d: string): Array<[number, number]> {
  return [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])
}

describe('sectionSvg', () => {
  it('draws at true scale: a 40 mm edge is 40 mm in the file, and the sheet is named in millimetres', () => {
    const { svg, width, height } = sectionSvg(plate(), info())
    expect(svg).toContain(`width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}"`)
    const outer = /data-part="plate" d="([^"]+?) Z M/.exec(svg)![1]
    const xs = pairs(outer).map((p) => p[0])
    const ys = pairs(outer).map((p) => p[1])
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(40, 6)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(30, 6)
  })

  it('has a scale bar as long as it says', () => {
    const { svg } = sectionSvg(plate(), info())
    const bar = /data-scale-bar="([\d.]+)"[^>]*>\s*<line x1="([\d.]+)" y1="[\d.]+" x2="([\d.]+)"/.exec(svg)!
    expect(Number(bar[3]) - Number(bar[2])).toBeCloseTo(Number(bar[1]), 6)
    expect(svg).toContain(`${bar[1]} mm</text>`)
  })

  it('puts what is up in the world up on the sheet, and turns the sheet when the plane\'s y points down', () => {
    const top = (svg: string): number => Math.min(...pairs(/data-part="plate" d="([^"]+?) Z M/.exec(svg)![1]).filter((p) => p[0] > 0).map((p) => p[1]))
    // v up: the point at v = +15 is the higher on the sheet (smaller y) than the one at v = -15.
    const up = pairs(/data-part="plate" d="([^"]+?) Z M/.exec(sectionSvg(plate(), info()).svg)![1])
    expect(up[2][1]).toBeLessThan(up[0][1])
    const turned = pairs(/data-part="plate" d="([^"]+?) Z M/.exec(sectionSvg(plate({ y: [0, 0, -1], x: [1, 0, 0], normal: [0, 1, 0] }), info()).svg)![1])
    expect(turned[2][1]).toBeGreaterThan(turned[0][1])
    expect(top(sectionSvg(plate(), info()).svg)).toBeGreaterThan(0)
  })

  it('cuts the hole out of the part with the even-odd rule', () => {
    const { svg } = sectionSvg(plate(), info())
    expect(svg).toMatch(/fill-rule="evenodd"/)
    expect(svg.match(/ Z/g)).toHaveLength(2)
  })

  it('draws a dimension that lies in the plane, as long as it measures, and leaves out one that does not', () => {
    const inside = dimension('M2', [[-20, 0, 5], [20, 0, 5]])
    const above = dimension('M3', [[-20, 0, 9], [20, 0, 9]])
    const unmeasured = dimension('M4', [[-20, 0, 5], [20, 0, 5]], { measuredRevision: 2 })
    const resolved = dimension('M5', [[-20, 0, 5], [20, 0, 5]], { status: 'resolved' })
    const other = dimension('M6', [[-20, 0, 5], [20, 0, 5]], { layout: 'print' })
    const drawn = sectionSvg(plate(), info([inside, above, unmeasured, resolved, other]))
    expect(drawn.dimensions).toEqual(['M2'])
    expect(drawn.left).toEqual([{ id: 'M4', why: 'not measured on this build' }])
    const g = /<g data-dimension="M2"[^>]*>\s*<line x1="([\d.-]+)" y1="([\d.-]+)" x2="([\d.-]+)" y2="([\d.-]+)"/.exec(drawn.svg)!
    expect(Math.hypot(Number(g[3]) - Number(g[1]), Number(g[4]) - Number(g[2]))).toBeCloseTo(40, 6)
    expect(drawn.svg).toContain('M2 40 mm (passes)')
    expect(drawn.svg).toContain('expected 40 ± 0.05')
  })

  it('says a failing dimension fails, and its expected value and tolerance as typed', () => {
    const miss = dimension('M2', [[-20, 0, 5], [20, 0, 5]], { value: 39.5, expected: 40.123, tolerance: 0.2, verdict: 'fail' })
    const { svg } = sectionSvg(plate(), info([miss]))
    expect(svg).toContain('M2 39.5 mm (fails)')
    expect(svg).toContain('expected 40.123 ± 0.2')
  })

  it('has a title block with the numbers in full, and ≈ where the kernel\'s area is not exact', () => {
    const exact = sectionSvg(plate({ origin: [0.1 + 0.2, 0, 5.12345678901] }), info()).svg
    expect(exact).toContain('(0.3, 0, 5.12345678901) mm')
    expect(exact).toContain('plate 1100 mm²')
    expect(exact).toContain('within 0.01 mm of the true ones')
    expect(exact).toContain('r3')
    expect(exact).toContain('2026-11-04')
    expect(exact).toContain('1:1')
    expect(sectionSvg(plate({}, false), info()).svg).toContain('plate ≈ 1100 mm²')
  })

  it('names the source only when it is given', () => {
    expect(sectionSvg(plate(), info()).svg).not.toContain('Source')
    expect(sectionSvg(plate(), { ...info(), source: 'a1b2c3' }).svg).toContain('a1b2c3')
  })

  it('sets a name as text, never as markup', () => {
    const { svg } = sectionSvg(plate(), { ...info(), object: '<script>x</script> & "y"' })
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;x&lt;/script&gt; &amp; &quot;y&quot;')
  })

  it('draws a plane that cuts nothing as a sheet with its title block', () => {
    const { svg } = sectionSvg({ ...plate(), parts: [{ part: 'plate', loops: [], area: 0, areaExact: true, open: 0, how: '' }], bounds: null }, info())
    expect(svg).toContain('plate, not cut')
  })
})

describe('the helpers', () => {
  it('takes the noise of floating point out of a number and nothing else', () => {
    expect(full(0.1 + 0.2)).toBe('0.3')
    expect(full(-0)).toBe('0')
    expect(full(1234.5678)).toBe('1234.5678')
  })
  it('gives a length of 1, 2 or 5 times a power of ten', () => {
    expect(niceLength(43)).toBe(20)
    expect(niceLength(50)).toBe(50)
    expect(niceLength(9.9)).toBe(5)
    expect(niceLength(0.3)).toBe(0.2)
    expect(niceLength(0)).toBe(1)
  })
})

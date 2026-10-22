import type { FilletDiagnosis } from '../shared/diagnosis'

/** The kernel's diagnosis of the probe of issue #49: a plate with a 12 mm pocket, its eight vertical edges at R6. */
export function probe(): FilletDiagnosis {
  const edge = (index: number, x: number, y: number) => ({
    index,
    type: 'line',
    length: 5,
    lengthExact: true,
    start: [x, y, -2.5] as [number, number, number],
    end: [x, y, 2.5] as [number, number, number],
    along: 'Z' as const,
    between: ['plane', 'plane']
  })
  const pair = (a: number, b: number) => ({ edges: [a, b] as [number, number], adjacent: true, apart: 12, apartExact: true })
  return {
    operation: 'fillet',
    size: 6,
    frame: 'local',
    edgeCount: 8,
    step: 0.001,
    budget: 5,
    alone: { tried: 8, failing: [] },
    pairs: { tried: 8, planned: 8, failing: [pair(4, 5), pair(4, 6), pair(5, 7), pair(6, 7)] },
    together: { worksUpTo: 5.999, failsAt: 6 },
    edges: [edge(4, -6, -6), edge(5, -6, 6), edge(6, 6, -6), edge(7, 6, 6)],
    complete: true,
    seconds: 0.16
  }
}

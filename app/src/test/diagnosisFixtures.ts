import type { BooleanDiagnosis, FilletDiagnosis } from '../shared/diagnosis'

/** The kernel's diagnosis of a cut whose tool ends flush with the top of a 10 mm block (`kernel/tests/test_booleans.py`). */
export function flushCut(): BooleanDiagnosis {
  return {
    operation: 'cut',
    frame: 'local',
    budget: 5,
    operands: [
      { name: 'base', type: 'solid', valid: true, solids: 1, faces: 6, box: { min: [-5, -5, -5], max: [5, 5, 5] } },
      { name: 'tool', type: 'solid', valid: true, solids: 1, faces: 6, box: { min: [-2, -2, 0], max: [2, 2, 5] } }
    ],
    pairs: [
      {
        base: 'base',
        tool: 'tool',
        apart: 0,
        apartExact: false,
        touching: true,
        inside: { tool: 4, base: 0, sampledOnTool: 20, sampledOnBase: 20 },
        coincident: [{ base: 'F5', tool: 'F5', kind: 'plane', facing: 'same', gap: 0, normal: [0, 0, 1], center: [0, 0, 5], area: 16, areaExact: true }]
      }
    ],
    causes: ['flush'],
    complete: true,
    seconds: 0.01
  }
}

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

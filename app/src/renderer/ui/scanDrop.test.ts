import { expect, it } from 'vitest'
import { droppedScan } from './scanDrop'

it('takes the first dropped file that is a scan, whatever the case of its ending', () => {
  expect(droppedScan([{ name: 'notes.txt' }, { name: 'Micra.GLB' }, { name: 'b.stl' }])).toBe(1)
  expect(droppedScan([{ name: 'part.3mf' }, { name: 'stl' }])).toBe(-1)
  expect(droppedScan([])).toBe(-1)
})

import { describe, expect, it } from 'vitest'
import { STARTER_MATERIALS, fitVerdict, leastWall, materialOf, printerOf, profileLine, profileName, profileOf, profilesOf } from './profile'

const x1c = { name: 'Bambu X1C', bed: [256, 256, 256], nozzle: 0.4 }

describe('profile', () => {
  it('keeps a printer and a material, and drops what is neither', () => {
    expect(printerOf(x1c)).toEqual({ name: 'Bambu X1C', bed: [256, 256, 256], nozzle: 0.4 })
    expect(printerOf({ ...x1c, bed: [256, 256] })).toBeNull()
    expect(printerOf({ ...x1c, nozzle: -1 })).toBeNull()
    expect(printerOf({ ...x1c, name: 'a\nb' })).toBeNull()
    expect(materialOf({ name: 'PETG', density: 1.27 })?.fits.sliding).toEqual([0.2, 0.3])
    expect(materialOf({ name: 'x', density: 0 })).toBeNull()
    expect(profileOf({ printer: x1c, material: { name: 'bad' } })).toEqual({ printer: printerOf(x1c) })
    expect(profilesOf({ printers: [x1c, x1c, 3], materials: 'no' })).toEqual({ printers: [printerOf(x1c)], materials: [] })
  })
  it('says a fit against its band', () => {
    expect(fitVerdict(0.25, [0.2, 0.3])).toEqual({ verdict: 'within', by: 0 })
    expect(fitVerdict(0.1, [0.2, 0.3]).verdict).toBe('tighter')
    expect(fitVerdict(0.5, [0.2, 0.3])).toMatchObject({ verdict: 'looser', by: 0.2 })
  })
  it('names the profile and takes the wall from the material, else the nozzle', () => {
    const petg = STARTER_MATERIALS[1]
    expect(profileName({ printer: printerOf(x1c)!, material: petg })).toBe('Bambu X1C, PETG')
    expect(leastWall({ printer: printerOf(x1c)! })).toBeCloseTo(0.8)
    expect(leastWall({ material: { ...petg, minWall: 1.2 } })).toBe(1.2)
    expect(leastWall(undefined)).toBeUndefined()
  })
  it('tells the profile in one line, or nothing', () => {
    expect(profileLine(undefined)).toBe('')
    expect(profileLine({})).toBe('')
    const line = profileLine({ printer: printerOf(x1c)!, material: STARTER_MATERIALS[1] })
    expect(line).toContain('Bambu X1C, bed 256 × 256 × 256 mm, nozzle 0.4 mm')
    expect(line).toContain('PETG, 1.27 g/cm³')
    expect(line).toContain('sliding 0.3 to 0.4')
    expect(line.includes('\n')).toBe(false)
    expect(line.length).toBeLessThan(700)
  })
})

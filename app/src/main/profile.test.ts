import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STARTER_MATERIALS, printerOf } from '../shared/profile'
import { UserProfiles, projectProfile, setProjectProfile } from './profile'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'torno-profile-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const x1c = { name: 'Bambu X1C', bed: [256, 256, 250], nozzle: 0.4 }

describe('the profile of a project', () => {
  it('is none until one is set, then is read back from .torno/profile.json with the values copied', async () => {
    expect(projectProfile(dir)).toBeUndefined()
    const kept = await setProjectProfile(dir, { printer: printerOf(x1c)!, material: STARTER_MATERIALS[1] })
    expect(kept?.material?.name).toBe('PETG')
    expect(projectProfile(dir)?.printer?.name).toBe('Bambu X1C')
    expect(JSON.parse(readFileSync(join(dir, '.torno', 'profile.json'), 'utf8')).material.density).toBe(1.27)
  })
  it('is none again when emptied, and when the file is not ours', async () => {
    await setProjectProfile(dir, { material: STARTER_MATERIALS[0] })
    expect(await setProjectProfile(dir, {})).toBeUndefined()
    expect(projectProfile(dir)).toBeUndefined()
    writeFileSync(join(dir, '.torno', 'profile.json'), 'not json')
    expect(projectProfile(dir)).toBeUndefined()
  })
  it('writes nothing where .torno is a file', async () => {
    writeFileSync(join(dir, '.torno'), 'x')
    await expect(setProjectProfile(dir, { material: STARTER_MATERIALS[0] })).rejects.toThrow()
  })
})

describe("the person's printers and materials", () => {
  it('offers the starter materials after their own, and keeps what they add', async () => {
    const file = join(dir, 'profiles.json')
    const store = new UserProfiles(file)
    expect((await store.list()).printers).toEqual([])
    expect((await store.list()).materials.map((m) => m.name)).toEqual(['PLA', 'PETG', 'ABS'])
    await store.savePrinter(x1c)
    await store.saveMaterial({ name: 'PETG', density: 1.3 })
    const again = await new UserProfiles(file).list()
    expect(again.printers.map((p) => p.name)).toEqual(['Bambu X1C'])
    expect(again.materials.map((m) => `${m.name} ${m.density}`)).toEqual(['PETG 1.3', 'PLA 1.24', 'ABS 1.04'])
    await store.removePrinter('Bambu X1C')
    expect((await store.list()).printers).toEqual([])
  })
  it('refuses what is not a printer or a material, and keeps in memory with no file', async () => {
    const store = new UserProfiles(null)
    await expect(store.savePrinter({ name: 'x' })).rejects.toThrow(/bed/)
    await expect(store.saveMaterial({ name: 'x' })).rejects.toThrow(/density/)
    await store.savePrinter(x1c)
    expect((await store.list()).printers).toHaveLength(1)
  })
})

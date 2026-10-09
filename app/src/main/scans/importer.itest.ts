import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parseScanMesh } from '../../shared/scans'
import { box, stl } from '../../test/scanFixtures'
import { scanCommand } from '../kernel/client'
import { processImporter } from './importer'

it('imports a real file with the real process, and changes its unit afterwards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'torno-import-'))
  try {
    writeFileSync(join(dir, 'box.stl'), stl(box([40, 30, 5])))
    const importer = processImporter((args) => scanCommand({ workspaceRoot: dir, hasProject: false, kernelDir: resolve(__dirname, '../../../../kernel') }, args), dir)
    const said = await importer.import(join(dir, 'box.stl'), join(dir, 'mesh.bin'), {})
    expect(said).toMatchObject({ unit: 'mm', up: 'z', vertices: 8, triangles: 12, colours: 'none', bbox: { min: [-20, -15, -2.5], max: [20, 15, 2.5] } })
    const bytes = readFileSync(join(dir, 'mesh.bin'))
    expect(parseScanMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).triangles).toHaveLength(36)
    const converted = await importer.convert(join(dir, 'mesh.bin'), { unit: 'mm', up: 'z' }, { unit: 'm', up: 'z' })
    expect(converted.bbox.max).toEqual([20000, 15000, 2500])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

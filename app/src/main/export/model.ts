import { type ExportChecked, type ExportRequest, MESH_ANGLE, MESH_TOLERANCE, type ModelFormat, defaultLayout } from '../../shared/exportdata'
import { partsNamed } from '../../shared/groups'
import type { Scene } from '../../shared/scene'
import type { SceneFile } from '../../shared/scenefile'
import type { ObjectInfo } from '../../shared/workspace'
import { NOT_BUILT, NO_OBJECT, ONE_OBJECT, hasSolid, partColors, switchedOff } from './build'

// A file of the model: STEP, STL or 3MF. It is made by the kernel's worker of the last good build, which holds the
// shapes (`export`), and comes back as bytes: main writes them beside the path the person chose and has the worker
// read that file back (`export_check`) before it takes the name. What goes is what the sheet asked: one object,
// one layout, its parts by name (a group's name stands for its parts), in the colours torno draws them. Nothing
// here names a path but the one the save dialog answered with, and no agent has a tool for it.

export interface ModelDeps {
  object(objectId: string): ObjectInfo | undefined
  last(objectId: string): { revision: number; scene: Scene } | undefined
  sceneFile(objectId: string): Promise<SceneFile>
  /** `Builds.query`. */
  query<T>(objectId: string, name: string, args: object, opts?: { blob?: boolean }): Promise<T>
}

/** What the kernel says it put in a file. */
export interface MadeFile {
  format: ModelFormat
  layout: string
  parts: Array<{ name: string; solids: number; volume: number; volumeExact: boolean; triangles?: number }>
  triangles?: number
  tolerance?: number
  angle?: number
  bytes: number
}

/** What the kernel found of a file read back. */
export interface FileCheck {
  passed: boolean
  problems: string[]
  objects: Array<{ name: string; solids?: number }>
  triangles?: number
  volumeDeviation: number | null
}

export interface ModelFile {
  objectId: string
  /** The build it is of: the one the worker that made it held. */
  revision: number
  args: Record<string, unknown>
  made: MadeFile
  bytes: Buffer
}

export const NO_PARTS = 'Tick a part to go in the file'
export const NO_LAYOUT = 'That layout is not in the build'
export const ONE_PART = 'An STL is of one part: for a plate of several, export a 3MF'
export const NOT_SOLID = 'An STL or a 3MF is of solids, and this part has none'
export const NEW_BUILD = 'A new build landed while the file was made: nothing was saved. Export again'
export const FAILED_CHECK = 'The file failed its check, and nothing was saved'

/** The kernel's arguments for a file of an object, from a request out of the window. Throws a sentence for the sheet. */
export async function modelArgs(deps: ModelDeps, req: ExportRequest & { format: ModelFormat }): Promise<{ objectId: string; args: Record<string, unknown> }> {
  if (req.objects.length !== 1) throw new Error(ONE_OBJECT)
  const objectId = req.objects[0]
  const obj = deps.object(objectId)
  if (!obj) throw new Error(NO_OBJECT)
  const last = deps.last(objectId)
  if (!last) throw new Error(NOT_BUILT)
  const { scene } = last
  const layout = req.layout ?? defaultLayout(req.format, scene.layouts)
  if (layout === undefined || !scene.layouts.includes(layout)) throw new Error(NO_LAYOUT)
  const file = await deps.sceneFile(objectId)
  const inLayout = scene.parts.filter((part) => part.layout === layout)
  // Unless the sheet names them: every part of the layout that is switched on, of solids alone for a mesh.
  const off = switchedOff(scene, file)
  const named = req.parts ?? inLayout.filter((part) => !off.has(part.name) && (req.format === 'step' || hasSolid(part))).map((part) => part.name)
  const parts = partsNamed(scene, layout, named)
  if (!Array.isArray(parts)) throw new Error(`There is no ${parts.unknown} in ${layout}`)
  if (parts.length === 0) throw new Error(NO_PARTS)
  if (req.format === 'stl' && parts.length !== 1) throw new Error(ONE_PART)
  if (req.format !== 'step' && inLayout.some((part) => parts.includes(part.name) && !hasSolid(part))) throw new Error(NOT_SOLID)
  const colors = partColors(scene, file)
  return {
    objectId,
    args: {
      format: req.format,
      layout,
      parts,
      colors: Object.fromEntries(parts.map((name) => [name, colors.get(name)!])),
      name: obj.name,
      ...(req.format === 'step' ? {} : { tolerance: req.tolerance ?? MESH_TOLERANCE, angle: req.angle ?? MESH_ANGLE })
    }
  }
}

/** The file, made by the kernel of the last good build: its bytes and what it holds. */
export async function makeModelFile(deps: ModelDeps, req: ExportRequest & { format: ModelFormat }): Promise<ModelFile> {
  const { objectId, args } = await modelArgs(deps, req)
  const { result, blob } = await deps.query<{ result: MadeFile; blob: Buffer }>(objectId, 'export', args, { blob: true })
  if (blob.length !== result.bytes) throw new Error(`The kernel said ${result.bytes} bytes and gave ${blob.length}: nothing was saved`)
  // The build whose worker answered: one that landed while it did would be of other shapes.
  const revision = deps.last(objectId)?.revision ?? 0
  return { objectId, revision, args, made: result, bytes: blob }
}

/**
 * Has the worker that made the file read it back from `beside` and hold it against its shapes. Resolves with what
 * the sheet says of it; throws, with every problem found, when it may not take its name, or when a new build came
 * between (the shapes would not be the file's).
 */
export async function checkModelFile(deps: ModelDeps, file: ModelFile, beside: string): Promise<ExportChecked> {
  if (deps.last(file.objectId)?.revision !== file.revision) throw new Error(NEW_BUILD)
  const found = await deps.query<FileCheck>(file.objectId, 'export_check', { ...file.args, path: beside })
  if (deps.last(file.objectId)?.revision !== file.revision) throw new Error(NEW_BUILD)
  if (!found.passed) throw new Error(`${FAILED_CHECK}: ${found.problems.join('; ')}`)
  const { made } = file
  return {
    format: made.format,
    layout: made.layout,
    parts: made.parts.map((part) => part.name),
    ...(made.format === 'step' ? { solids: found.objects.reduce((sum, one) => sum + (one.solids ?? 0), 0) } : { triangles: found.triangles, tolerance: made.tolerance, angle: made.angle }),
    volumeDeviation: found.volumeDeviation
  }
}

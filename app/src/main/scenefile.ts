import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LayerSettings, SceneFile } from '../shared/scenefile'

export type { LayerSettings, SceneFile }

const FOLDER = '.torno'
const NAME = 'scene.json'

/**
 * How the object in `dir` was last looked at. A file that is missing, unreadable
 * or not what this version writes gives the defaults; it is left as it is.
 */
export async function loadSceneFile(dir: string): Promise<SceneFile> {
  try {
    return clean(JSON.parse(await readFile(join(dir, FOLDER, NAME), 'utf8')))
  } catch {
    return { layers: {} }
  }
}

/** The last write to each file, so that saves of one file land in the order they were made. */
const writes = new Map<string, Promise<void>>()

/** Writes `<dir>/.torno/scene.json`, creating the folder. Readers see the old file or the new one, never half of one. */
export function saveSceneFile(dir: string, f: SceneFile): Promise<void> {
  const folder = join(dir, FOLDER)
  const path = join(folder, NAME)
  const text = `${JSON.stringify(clean(f), null, 2)}\n`
  const write = (writes.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await mkdir(folder, { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, text)
      await rename(temp, path)
    })
    .finally(() => {
      if (writes.get(path) === write) writes.delete(path)
    })
  writes.set(path, write)
  return write
}

/** Keeps what a scene file may hold, whatever it was given. */
function clean(value: unknown): SceneFile {
  const file: SceneFile = { layers: {} }
  if (!isRecord(value)) return file
  if (typeof value.layout === 'string') file.layout = value.layout
  if (!isRecord(value.layers)) return file
  for (const [name, raw] of Object.entries(value.layers)) {
    if (!isRecord(raw)) continue
    const layer: LayerSettings = {}
    if (typeof raw.visible === 'boolean') layer.visible = raw.visible
    if (typeof raw.color === 'string') layer.color = raw.color
    if (typeof raw.opacity === 'number' && Number.isFinite(raw.opacity)) layer.opacity = Math.min(Math.max(raw.opacity, 0), 1)
    if (Object.keys(layer).length > 0) file.layers[name] = layer
  }
  return file
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

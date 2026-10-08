import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ObjectInfo, WorkspaceInfo } from '../shared/workspace'

// Folders of a workspace that are never objects.
const RESERVED = new Set(['common', 'tests', 'out'])

/** Same rule as the kernel's loader (`_is_test_file`). */
function isTestFile(name: string): boolean {
  return name.startsWith('test_') || name.endsWith('_test.py') || name === 'conftest.py'
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

/** The `.py` files directly inside a folder, sorted. Empty when it is not a readable folder. */
async function pythonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.py')) continue
    const isFile = entry.isSymbolicLink()
      ? await stat(join(dir, entry.name)).then((s) => s.isFile(), () => false)
      : entry.isFile()
    if (isFile) names.push(entry.name)
  }
  return names.sort()
}

/**
 * The objects of a workspace: one per immediate subfolder that holds a `.py`
 * file. The model is chosen as the kernel's `choose_model` would, with the same
 * message when it cannot be.
 */
export async function scanWorkspace(root: string): Promise<WorkspaceInfo> {
  const entries = await readdir(root, { withFileTypes: true })
  const objects: ObjectInfo[] = []
  for (const entry of entries) {
    const name = entry.name
    if (name.startsWith('.') || name.startsWith('_') || RESERVED.has(name)) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(root, name)
    const files = await pythonFiles(dir)
    if (files.length === 0) continue
    const candidates = files.filter((file) => !isTestFile(file))
    if (candidates.length === 1) {
      objects.push({ id: name, name, dir, model: candidates[0] })
    } else {
      const problem =
        candidates.length === 0
          ? `no model file in ${dir}`
          : `more than one model file in ${dir}: ${candidates.join(', ')}`
      objects.push({ id: name, name, dir, model: null, problem })
    }
  }
  objects.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { root, hasProject: await exists(join(root, 'pyproject.toml')), objects }
}

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

/** As the kernel's loader: `helmet-stand` and `helmet_stand` name the same thing. */
function sameName(a: string, b: string): boolean {
  return a.replaceAll('-', '_') === b.replaceAll('-', '_')
}

/**
 * The `.py` files directly inside a folder that could be a model or a test,
 * sorted: not dotfiles, not `__init__.py`. Empty when it is not a readable folder.
 */
async function pythonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.py') || entry.name.startsWith('.') || entry.name === '__init__.py') continue
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
 * message when it cannot be: the one file that is not a test, or, of several,
 * the one named after the folder (`helmet-stand/helmet_stand.py`).
 *
 * This is a fresh choice. For an object that is open, `Builds.choice` keeps
 * the model it is building for as long as that file exists.
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
    const named = candidates.filter((file) => sameName(file.slice(0, -'.py'.length), name))
    const chosen = candidates.length === 1 ? candidates : named
    if (chosen.length === 1) {
      objects.push({ id: name, name, dir, model: chosen[0] })
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

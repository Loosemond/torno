import { SHADOWING_LIBRARIES, STDLIB_MODULES } from './pythonModules'

// The name of a new object is the name of its folder, and its model file is the same name as a Python module.
// What the workspace and the kernel already require of an object folder holds here, and a little more, since
// torno makes the folder: one function, so that the window says what main will refuse.

/** The longest name of an object, in characters. */
export const MAX_OBJECT_NAME = 64

/** The most of each kind of reference a new object is made with: the window holds the draft to it, main holds the request to it. */
export const MOST_REFERENCES = { photos: 12, doodles: 6, scans: 4, objects: 8 }

/** Folders a workspace keeps for itself (the first three are never objects; the rest torno gives a meaning). */
const RESERVED = ['common', 'tests', 'out', 'docs', 'tools', 'reference']

const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
  'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield'
])

/** `cable-clip` -> `cable_clip`: the model file's name without `.py`, a name Python can import. */
export function moduleName(name: string): string {
  return name.replaceAll('-', '_').replaceAll('.', '_')
}

/**
 * Why `name` cannot be a new object's folder, in a sentence for the person; null when it can. `existing` is
 * every name in the workspace's folder (folders and files), compared without regard to case: a disk may not
 * tell `Clip` from `clip`, and the kernel takes `a-b` and `a_b` for the same model.
 */
export function objectNameProblem(name: string, existing: readonly string[]): string | null {
  if (name === '') return 'Give the object a name.'
  if (name.length > MAX_OBJECT_NAME) return `A name is at most ${MAX_OBJECT_NAME} characters.`
  if (!/^[A-Za-z0-9]/.test(name)) return 'A name starts with a letter or a digit.'
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'A name has only letters, digits, `.`, `-` and `_`.'
  if (RESERVED.includes(name.toLowerCase())) return `\`${name}\` is a name the workspace keeps for itself.`
  const module = moduleName(name)
  if (KEYWORDS.has(module)) return `\`${name}\` is a Python keyword, and the model is a Python module.`
  // The object's folder leads `sys.path`: its model would stand in for the library of that name.
  const lowerModule = module.toLowerCase()
  if (SHADOWING_LIBRARIES.some((lib) => lib.toLowerCase() === lowerModule)) return `\`${name}\` is the name of a library the model imports; the model would stand in its place.`
  if (STDLIB_MODULES.some((lib) => lib.toLowerCase() === lowerModule)) return `\`${name}\` is a module of Python's standard library; the model would stand in its place.`
  // The loader and the workspace take these for tests, not models (`_is_test_file`).
  if (module.startsWith('test_') || module.endsWith('_test') || module === 'conftest') return 'A name that starts with `test_` or ends with `_test` makes a test file, not a model.'
  const lower = name.toLowerCase()
  for (const other of existing) {
    if (other.toLowerCase() === lower) return `A folder \`${other}\` is there already.`
  }
  for (const other of existing) {
    if (moduleName(other).toLowerCase() === module.toLowerCase()) return `A folder \`${other}\` is there already, and names the same model.`
  }
  return null
}

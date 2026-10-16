import { describe, expect, it } from 'vitest'
import { STDLIB_MODULES } from './pythonModules'
import { MAX_PHOTO_BYTES, moduleName, objectNameProblem } from './objectName'

describe('objectNameProblem', () => {
  it('accepts letters, digits, dot, dash and underscore', () => {
    for (const name of ['clip', 'cable-clip', 'Cable_Clip.v2', '3d-stand', 'a', 'x'.repeat(64)]) {
      expect(objectNameProblem(name, [])).toBeNull()
    }
  })

  it('refuses an empty name, one that is too long, and one that starts with a dot, dash or underscore', () => {
    expect(objectNameProblem('', [])).toMatch(/name/i)
    expect(objectNameProblem('x'.repeat(65), [])).toMatch(/64/)
    for (const name of ['.hidden', '-x', '_x', '..']) expect(objectNameProblem(name, [])).not.toBeNull()
  })

  it('refuses a slash, a backslash, a space, `..` inside a path, unicode lookalikes and control characters', () => {
    for (const name of ['a/b', 'a\\b', '../x', 'a b', 'a/../b', 'café', 'аpple', 'a\u0000b', 'a\nb', ' a', 'a ']) {
      expect(objectNameProblem(name, []), JSON.stringify(name)).not.toBeNull()
    }
  })

  it('refuses the names the workspace keeps for itself, in any case', () => {
    for (const name of ['common', 'tests', 'out', 'docs', 'tools', 'reference', 'Common', 'OUT']) {
      expect(objectNameProblem(name, []), name).toMatch(/keeps for itself/)
    }
  })

  it('refuses a Python keyword, as the module would be one', () => {
    for (const name of ['class', 'for', 'None', 'True', 'import']) expect(objectNameProblem(name, []), name).toMatch(/Python/)
  })

  it('refuses a name whose model file would be taken for a test', () => {
    for (const name of ['test-clip', 'test_clip', 'clip-test', 'conftest']) expect(objectNameProblem(name, []), name).toMatch(/test/)
    expect(objectNameProblem('testing', [])).toBeNull()
  })

  it('refuses a folder that is there, in any case, and one that is the same module', () => {
    expect(objectNameProblem('clip', ['clip'])).toBe('A folder `clip` is there already.')
    expect(objectNameProblem('Clip', ['clip'])).toBe('A folder `clip` is there already.')
    expect(objectNameProblem('cable-clip', ['cable_clip'])).toMatch(/cable_clip/)
    expect(objectNameProblem('other', ['clip'])).toBeNull()
  })
})

describe('names that would shadow a library', () => {
  it('refuses what a model or the worker imports, and torno\'s own, in any case', () => {
    for (const name of ['build123d', 'OCP', 'ocp', 'numpy', 'typing', 'dataclasses', 'math', 'json', 'JSON', 'os', 'sys', 'pathlib', 'functools', 'common', 'torno', 'torno_kernel', 'torno-kernel']) {
      expect(objectNameProblem(name, []), name).not.toBeNull()
    }
  })

  it('refuses any module of the standard library, and says so', () => {
    for (const name of ['random', 'string', 'collections', 'logging', 'zlib', 'cProfile', 'cprofile']) expect(objectNameProblem(name, []), name).toMatch(/library/)
  })

  it('has the list as it was generated: 212 names, none starting with an underscore, and the names a model would use are not on it', () => {
    expect(STDLIB_MODULES).toHaveLength(212)
    expect(STDLIB_MODULES.some((m) => m.startsWith('_'))).toBe(false)
    for (const name of ['clip', 'bracket', 'lid', 'cable-clip', 'stand', 'mount']) expect(objectNameProblem(name, []), name).toBeNull()
  })
})

describe('moduleName', () => {
  it('turns dashes and dots into underscores', () => {
    expect(moduleName('cable-clip')).toBe('cable_clip')
    expect(moduleName('v1.2-b')).toBe('v1_2_b')
    expect(moduleName('plain')).toBe('plain')
  })
})

it('has one cap for a photo, which main and the window both hold a file to', () => {
  expect(MAX_PHOTO_BYTES).toBe(25 * 1024 * 1024)
})

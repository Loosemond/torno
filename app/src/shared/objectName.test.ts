import { describe, expect, it } from 'vitest'
import { moduleName, objectNameProblem } from './objectName'

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

describe('moduleName', () => {
  it('turns dashes and dots into underscores', () => {
    expect(moduleName('cable-clip')).toBe('cable_clip')
    expect(moduleName('v1.2-b')).toBe('v1_2_b')
    expect(moduleName('plain')).toBe('plain')
  })
})

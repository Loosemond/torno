import { describe, expect, it } from 'vitest'
import { clampLeft, COLUMN_DEFAULT, LEFT_DEFAULT, COLUMN_KEY, MARKS_FLOOR, readColumn, switcherShown, writeColumn } from './column'

/** A storage of the window, as the tests need it: what was written, and one that refuses. */
function memory(start: Record<string, string> = {}): Storage & { data: Record<string, string> } {
  const data = { ...start }
  return {
    data,
    get length() {
      return Object.keys(data).length
    },
    clear: () => Object.keys(data).forEach((key) => delete data[key]),
    key: (n: number) => Object.keys(data)[n] ?? null,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => void (data[key] = value),
    removeItem: (key: string) => void delete data[key]
  }
}

const refusing = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  }
} as unknown as Storage

describe('the left column as the person keeps it', () => {
  it('starts with Objects folded to its switcher, the rest unfolded, and the marks at their share', () => {
    expect(COLUMN_DEFAULT).toEqual({ folded: { objects: true, layers: false, params: true, checks: true, scans: false }, marks: null, width: null })
    expect(readColumn(memory())).toEqual(COLUMN_DEFAULT)
    expect(readColumn(null)).toEqual(COLUMN_DEFAULT)
  })

  it('reads back what was written, and nothing but the window keeps it', () => {
    const storage = memory()
    writeColumn(storage, { folded: { objects: false, layers: true, params: false, checks: true, scans: true }, marks: 320, width: 400 })
    expect(Object.keys(storage.data)).toEqual([COLUMN_KEY])
    expect(readColumn(storage)).toEqual({ folded: { objects: false, layers: true, params: false, checks: true, scans: true }, marks: 320, width: 400 })
  })

  it('takes what it can of a value that is not its own, and the default for the rest', () => {
    expect(readColumn(memory({ [COLUMN_KEY]: 'not json' }))).toEqual(COLUMN_DEFAULT)
    expect(readColumn(memory({ [COLUMN_KEY]: '[1, 2]' }))).toEqual(COLUMN_DEFAULT)
    expect(readColumn(memory({ [COLUMN_KEY]: JSON.stringify({ folded: { layers: true, scans: 'yes' }, marks: 'tall' }) }))).toEqual({ folded: { objects: true, layers: true, params: true, checks: true, scans: false }, marks: null, width: null })
    // A height under the floor of the marks is no height they are given: the floor holds anyway.
    expect(readColumn(memory({ [COLUMN_KEY]: JSON.stringify({ marks: MARKS_FLOOR - 1 }) })).marks).toBeNull()
    expect(readColumn(memory({ [COLUMN_KEY]: JSON.stringify({ marks: Number.POSITIVE_INFINITY }) })).marks).toBeNull()
  })

  it('never throws for a storage that refuses: the window works without it', () => {
    expect(readColumn(refusing)).toEqual(COLUMN_DEFAULT)
    expect(() => writeColumn(refusing, COLUMN_DEFAULT)).not.toThrow()
    expect(() => writeColumn(null, COLUMN_DEFAULT)).not.toThrow()
  })
})

describe('switcherShown', () => {
  const two = [{ id: 'bracket' }, { id: 'hollow' }]
  const at = (over: Partial<Parameters<typeof switcherShown>[0]>) => switcherShown({ folded: true, objects: two, objectId: 'hollow', page: 'object', ...over })

  it('is the folded list while an object is open, or a new one is being made, in a workspace of several', () => {
    expect(at({})).toBe(true)
    expect(at({ page: 'new' })).toBe(true)
    expect(at({ page: 'new', objectId: null })).toBe(true)
  })

  it('shows the list whole when it is unfolded, with no object open, on the page of objects, or with one object alone', () => {
    expect(at({ folded: false })).toBe(false)
    expect(at({ objectId: null })).toBe(false)
    expect(at({ page: 'objects' })).toBe(false)
    expect(at({ objects: [{ id: 'hollow' }] })).toBe(false)
  })
})

describe('the width of the column', () => {
  it('is kept only when it is wider than the default', () => {
    expect(readColumn(memory({ [COLUMN_KEY]: JSON.stringify({ width: 360.4 }) })).width).toBe(360)
    for (const width of [LEFT_DEFAULT, 100, 'wide', null]) expect(readColumn(memory({ [COLUMN_KEY]: JSON.stringify({ width }) })).width).toBeNull()
  })

  it('is bounded below by the default and above by the room the viewport keeps beside the dock', () => {
    expect(clampLeft(100, 1600, 520)).toBe(LEFT_DEFAULT)
    expect(clampLeft(400, 1600, 520)).toBe(400)
    expect(clampLeft(5000, 1600, 520)).toBe(1600 - 520 - 240)
    expect(clampLeft(5000, 1600, 0)).toBe(1600 - 240)
    expect(clampLeft(5000, 600, 520)).toBe(LEFT_DEFAULT)
  })
})

import { describe, expect, it } from 'vitest'
import type { Param } from '../../shared/scene'
import { bakeText, paramRow } from './paramRows'

const param = (more: Partial<Param>): Param => ({ name: 'wall', type: 'float', default: 2.4, literal: true, doc: null, ...more })

describe('the row of a field of Params', () => {
  it('shows a literal number as the format of numbers has it, with the full value when that is shorter', () => {
    expect(paramRow(param({ default: 2.4 }))).toMatchObject({ value: '2.4', full: null, worked: false, text: 'Params.wall' })
    expect(paramRow(param({ default: 2.123456789 }))).toMatchObject({ value: '2.123', full: '2.123456789' })
    expect(paramRow(param({ name: 'count', type: 'int', default: 4 }))).toMatchObject({ value: '4', full: null })
  })

  it('gives the comment as written and infers no unit from it', () => {
    const row = paramRow(param({ doc: 'Wall thickness, mm' }))
    expect(row.doc).toBe('Wall thickness, mm')
    expect(row.value).toBe('2.4')
    expect(paramRow(param({ doc: null })).doc).toBeNull()
  })

  it('says a default worked out in the model is, and still shows its value when the kernel has one', () => {
    expect(paramRow(param({ name: 'inner', default: 18.4, literal: false }))).toMatchObject({ worked: true, value: '18.4' })
    expect(paramRow(param({ name: 'inner', default: null, literal: false }))).toMatchObject({ worked: true, value: null })
  })

  it('shows what is not a number plainly', () => {
    expect(paramRow(param({ type: 'bool', default: true }))).toMatchObject({ value: 'True', full: null })
    expect(paramRow(param({ type: 'bool', default: false })).value).toBe('False')
    expect(paramRow(param({ type: 'str', default: 'M3' })).value).toBe('"M3"')
    expect(paramRow(param({ type: 'tuple', default: [1.5, 2.123456, 3] }))).toMatchObject({ value: '[1.5, 2.123, 3]', full: '[1.5, 2.123456, 3]' })
    expect(paramRow(param({ type: 'None', default: null, literal: true })).value).toBe('None')
  })

  it('describes the field for a title: name, type as written, the full value and the comment', () => {
    expect(paramRow(param({ default: 2.123456789, doc: 'Wall' })).title).toBe('Params.wall: float = 2.123456789. Wall')
    expect(paramRow(param({ default: 2.4 })).title).toBe('Params.wall: float = 2.4')
    expect(paramRow(param({ default: null, literal: false })).title).toBe('Params.wall: float, worked out in the model')
  })
})

describe('a field the person is trying another value for', () => {
  const offered = (more: Partial<Param>): Param => param({ editable: 'float', value: 2.4, default: 2, ...more })

  it('has its current value and the file’s only where they differ', () => {
    expect(paramRow(offered({}))).toMatchObject({ editable: 'float', current: 2.4, file: '2' })
    expect(paramRow(offered({ value: 2 }))).toMatchObject({ current: 2, file: null })
    expect(paramRow(param({ editable: null, default: 'x' }))).toMatchObject({ editable: null, file: null })
  })

  it('asks for the defaults to be set in the model, each with what the file has', () => {
    expect(bakeText([offered({}), offered({ name: 'lid', type: 'bool', editable: 'bool', default: true, value: false }), offered({ name: 'ribs', value: 4, default: 4 })])).toBe(
      'Make Params.wall to 2.4 (the file has 2) and Params.lid to False (the file has True) the defaults in the model: I tried them in torno and want to keep them.'
    )
    expect(bakeText([offered({})])).toBe('Make Params.wall to 2.4 (the file has 2) the default in the model: I tried it in torno and want to keep it.')
    expect(bakeText([offered({ value: 2 })])).toBe('')
  })
})

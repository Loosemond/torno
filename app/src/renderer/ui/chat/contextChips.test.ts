import { describe, expect, it } from 'vitest'
import { contextChips } from './contextChips'

describe('the chips for what torno added to a prompt', () => {
  it('reads the build and the selection from the text the agent was given', () => {
    const text = '[torno] box · build ok · r12 (0.8 s) · layout assembly · parts: lid, tub.\nSelected: lid/F12 (plane, normal +Z), tub/E3 and 2 more\nOpen marks: M1, M2'
    expect(contextChips(text)).toEqual({ build: { revision: 12, state: 'ok' }, selection: ['lid/F12', 'tub/E3'] })
  })

  it('says a build that failed or is running, and the revision still on screen', () => {
    expect(contextChips('[torno] box · BUILD FAILED · showing r4 (stale).\nboom')).toEqual({ build: { revision: 4, state: 'failed' }, selection: [] })
    expect(contextChips('[torno] box · building (3 s so far) · showing r4.')).toEqual({ build: { revision: 4, state: 'building' }, selection: [] })
  })

  it('has no build chip when there is no revision to name', () => {
    expect(contextChips('[torno] box · not built yet.')).toEqual({ build: undefined, selection: [] })
    expect(contextChips('[torno] box · BUILD FAILED · nothing built yet.\nboom')).toEqual({ build: undefined, selection: [] })
    expect(contextChips('')).toEqual({ build: undefined, selection: [] })
  })

  it('names a ref of the selection once, and not a mark described in the same text', () => {
    expect(contextChips('[torno] a · build ok · r1.\nSelected: lid/F1, lid/F1\nMarks from the user:\nM3 pin on lid/F9').selection).toEqual(['lid/F1'])
  })
})

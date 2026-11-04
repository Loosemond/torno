import { describe, expect, it } from 'vitest'
import { gitFilesSaid, gitSaid, identitySaid } from './git'

describe('gitSaid', () => {
  it('says how many files changed since the commit', () => {
    expect(gitSaid({ head: 'a1b2c3d', branch: 'main', files: [], changed: 3 })).toBe('3 files changed since a1b2c3d')
    expect(gitSaid({ head: 'a1b2c3d', branch: null, files: [], changed: 1 })).toBe('1 file changed since a1b2c3d')
    expect(gitSaid({ head: 'a1b2c3d', branch: null, files: [], changed: 0 })).toBe('No changes since a1b2c3d')
  })

  it('says so when there is no commit yet', () => {
    expect(gitSaid({ head: null, branch: 'main', files: [], changed: 0 })).toBe('No commit yet')
    expect(gitSaid({ head: null, branch: 'main', files: [], changed: 2 })).toBe('2 files not committed yet')
  })
})

describe('gitFilesSaid', () => {
  it('lists the files and counts those it does not name', () => {
    expect(gitFilesSaid({ head: 'a', branch: null, files: ['box/a.py', 'box/b.py'], changed: 5 })).toBe('box/a.py\nbox/b.py\nand 3 more')
  })
})

describe('identitySaid', () => {
  it('says the sources and the commit they stood on', () => {
    expect(identitySaid({ sources: '9f3e1a2b4c5d' })).toBe('sources 9f3e1a2b4c5d')
    expect(identitySaid({ sources: '9f3e1a2b4c5d', head: 'a1b2c3d' })).toBe('sources 9f3e1a2b4c5d, on a1b2c3d')
    expect(identitySaid({ sources: '9f3e1a2b4c5d', head: 'a1b2c3d', dirty: true })).toBe('sources 9f3e1a2b4c5d, on a1b2c3d with changes')
  })
})

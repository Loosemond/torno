import { describe, expect, it } from 'vitest'
import type { Scene } from '../shared/scene'
import { RecentMeshes } from './meshes'

const mesh = (bytes: number) => ({ scene: {} as Scene, blob: Buffer.alloc(bytes) })

describe('RecentMeshes', () => {
  it('keeps what fits the budget, and gives back a build by its revision', () => {
    const held = new RecentMeshes(100)
    held.keep('box', 1, mesh(40))
    held.keep('box', 2, mesh(40))
    held.keep('box', 3, mesh(40))
    expect(held.revisions('box')).toEqual([1, 2, 3])
    expect(held.get('box', 2)?.blob.length).toBe(40)
    expect(held.get('box', 9)).toBeUndefined()
  })

  it('lets the oldest go first when the budget is passed, and never the newest build of an object', () => {
    const held = new RecentMeshes(100)
    for (const revision of [1, 2, 3, 4]) held.keep('box', revision, mesh(60))
    // The newest is not counted against the budget; of the others, one fits.
    expect(held.revisions('box')).toEqual([3, 4])
    const alone = new RecentMeshes(10)
    alone.keep('lid', 1, mesh(500))
    expect(alone.revisions('lid')).toEqual([1])
  })

  it('weighs all the objects together, and forgets a closed one', () => {
    const held = new RecentMeshes(100)
    held.keep('box', 1, mesh(60))
    held.keep('box', 2, mesh(10))
    held.keep('lid', 1, mesh(60))
    held.keep('lid', 2, mesh(10))
    // Two older builds of 60 each pass 100: the first kept goes.
    expect(held.revisions('box')).toEqual([2])
    expect(held.revisions('lid')).toEqual([1, 2])
    held.forget('lid')
    expect(held.revisions('lid')).toEqual([])
    expect(held.bytes).toBe(10)
  })

  it('keeps a build kept again once', () => {
    const held = new RecentMeshes(100)
    held.keep('box', 1, mesh(10))
    held.keep('box', 1, mesh(20))
    expect(held.bytes).toBe(20)
  })
})

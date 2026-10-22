import { describe, expect, it } from 'vitest'
import { needsCamera } from './labels'

describe('bringing a selected mark into view', () => {
  it('moves the camera only for a mark whose label is not in view, or is not drawn at all', () => {
    expect(needsCamera({ visible: true })).toBe(false)
    expect(needsCamera({ visible: false })).toBe(true)
    expect(needsCamera(null)).toBe(true)
  })
})

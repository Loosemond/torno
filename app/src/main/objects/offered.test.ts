import { describe, expect, it } from 'vitest'
import { Offered } from './offered'

describe('the paths main offered the window', () => {
  it('knows the paths it was given, and only those', () => {
    const offered = new Offered()
    offered.add(['/a/one.png', '/a/two.jpg'])
    expect(offered.has('/a/one.png')).toBe(true)
    expect(offered.has('/a/other.png')).toBe(false)
    expect(offered.has(42)).toBe(false)
  })
  it('forgets all of them when cleared, and keeps no more than a few hundred', () => {
    const offered = new Offered()
    offered.add(['/a/one.png'])
    offered.clear()
    expect(offered.has('/a/one.png')).toBe(false)
    offered.add(Array.from({ length: 600 }, (_, n) => `/p/${n}.png`))
    expect(offered.has('/p/599.png')).toBe(true)
    expect(offered.has('/p/0.png')).toBe(false)
  })
})

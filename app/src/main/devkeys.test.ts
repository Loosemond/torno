import { describe, expect, it } from 'vitest'
import { devShortcut } from './devkeys'

const key = (key: string, mods: Partial<{ control: boolean; shift: boolean; alt: boolean; meta: boolean; type: string }> = {}) =>
  devShortcut({ type: 'keyDown', key, control: false, shift: false, alt: false, meta: false, ...mods })

describe('devShortcut', () => {
  it('reloads on F5 and Ctrl+R', () => {
    expect(key('F5')).toBe('reload')
    expect(key('r', { control: true })).toBe('reload')
    expect(key('R', { control: true })).toBe('reload')
  })

  it('opens the developer tools on F12 and Ctrl+Shift+I', () => {
    expect(key('F12')).toBe('devtools')
    expect(key('I', { control: true, shift: true })).toBe('devtools')
  })

  it('leaves every other key alone, and the release of these', () => {
    expect(key('r')).toBeNull()
    expect(key('r', { control: true, shift: true })).toBeNull()
    expect(key('i', { control: true })).toBeNull()
    expect(key('F5', { alt: true })).toBeNull()
    expect(key('F5', { type: 'keyUp' })).toBeNull()
    expect(key('v', { control: true, shift: true })).toBeNull()
  })
})

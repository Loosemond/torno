import { describe, expect, it } from 'vitest'
import { devShortcut } from './devkeys'

const key = (key: string, mods: Partial<{ control: boolean; shift: boolean; alt: boolean; meta: boolean; type: string }> = {}, allow = { reload: true }) =>
  devShortcut({ type: 'keyDown', key, control: false, shift: false, alt: false, meta: false, ...mods }, allow)

describe('devShortcut', () => {
  it('opens the developer tools wherever the app is not packaged, and reloads only under the dev server', () => {
    // In the app as built, Ctrl+R and F5 are the agent's CLI's own keys: they reach the terminal.
    const built = { reload: false }
    expect(key('F12', {}, built)).toBe('devtools')
    expect(key('I', { control: true, shift: true }, built)).toBe('devtools')
    expect(key('F5', {}, built)).toBeNull()
    expect(key('r', { control: true }, built)).toBeNull()
    expect(key('r', { control: true }, { reload: true })).toBe('reload')
  })

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

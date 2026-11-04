import { describe, expect, it } from 'vitest'
import type { Mark } from '../../shared/marks'
import { commitPrompt, committable } from './AskToCommit'

const mark = (id: string, over: Partial<Mark> = {}): Mark => ({ id, kind: 'pin', author: 'user', note: '', status: 'resolved', resolvedBy: 'agent', acknowledged: true, anchorState: 'ok', layout: 'assembly', revision: 1, camera: { position: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0], ortho: true, fov: 35, zoom: 1 }, createdAt: '', anchor: { point: [0, 0, 0] }, ...over }) as Mark

describe('committable', () => {
  it('names the marks the agent resolved and the person has seen, in order', () => {
    const marks = [mark('M6'), mark('M4'), mark('M5', { acknowledged: false }), mark('M3', { resolvedBy: 'user' }), mark('M2', { status: 'sent' })]
    expect(committable(marks)).toEqual(['M4', 'M6'])
  })

  it('names the newest six at most, by number', () => {
    const marks = Array.from({ length: 9 }, (_, i) => mark(`M${i + 1}`))
    expect(committable(marks)).toEqual(['M4', 'M5', 'M6', 'M7', 'M8', 'M9'])
  })
})

describe('commitPrompt', () => {
  it('asks for a commit of the changes for the marks, and of this project only', () => {
    expect(commitPrompt(['M4', 'M6'])).toBe("Commit the changes for M4 and M6 of this project with a message saying what changed. Add only this project's files.")
    expect(commitPrompt(['M2', 'M4', 'M6'])).toMatch(/for M2, M4 and M6 /)
    expect(commitPrompt(['M4'])).toMatch(/for M4 /)
    expect(commitPrompt([])).toMatch(/^Commit the changes of this project/)
  })
})

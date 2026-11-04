import { type Landing, landing } from '../../shared/diff'
import type { TornoState } from './store'

let last: { before: object; scene: object; layout: string; told: Landing } | null = null

/**
 * What the build on show did to the parts of the layout shown, against the one before it; null for the first
 * build of an object. The same value while nothing it is of changed, so that a selector may hand it to React.
 */
export function landedOn(s: Pick<TornoState, 'before' | 'scene' | 'layout'>): Landing | null {
  if (!s.before || !s.scene) return null
  if (last && last.before === s.before && last.scene === s.scene && last.layout === s.layout) return last.told
  last = { before: s.before, scene: s.scene, layout: s.layout, told: landing(s.before, s.scene, s.layout) }
  return last.told
}

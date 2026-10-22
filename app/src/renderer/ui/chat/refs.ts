import { markAnchors } from '../../../shared/marks'
import { layerOf, type TornoState } from '../../state/store'

/** What a ref shown in the chat is, and what the window can do with it. */
export interface RefInfo {
  kind: 'mark' | 'build' | 'geometry' | 'none'
  /** Whether it names something in the window now: only such a chip lights, and answers a click. */
  live: boolean
  /** The refs of the layout shown to light in the viewport while the pointer is on the chip. */
  lights: string[]
  /** What a click does: go to the mark, select the face or edge, or open the sheet of the failed build. */
  act?: 'focus' | 'select' | 'build'
  /** For a mark, who made it: its chip is in its colour. */
  author?: 'user' | 'agent'
  /** The tooltip: what it is, or why it does nothing. */
  title: string
  /** It names nothing this object has (a mark it has not, a build it has not made, a part the build lacks): in prose it is only text. */
  plain: boolean
}

const NOTE_WORDS = 80

/** What a ref (`M4`, `r12`, `lid/F12`, `lid/E3`) is among what the window shows now. */
/** The parts of the state a ref depends on: the rest of it (the selection, the camera) cannot change what a chip says. */
export type RefState = Pick<TornoState, 'marks' | 'scene' | 'layers' | 'layout' | 'revision' | 'build'>

export function refInfo(s: RefState, value: string): RefInfo {
  if (/^M\d+$/.test(value)) {
    const mark = s.marks.find((m) => m.id === value)
    if (!mark) return { kind: 'mark', live: false, lights: [], plain: true, title: `${value} is not among the marks of this object` }
    if (mark.kind !== 'region' && s.scene !== null && !s.scene.layouts.includes(mark.layout)) {
      return { kind: 'mark', live: false, lights: [], plain: false, author: mark.author, title: `${value} is on the layout ${mark.layout}, which this build does not have` }
    }
    // Lit where it is tied to the part, when the layout it is in is the one shown.
    const lights = mark.layout === s.layout ? markAnchors(mark).flatMap((a) => (a.ref ? [a.ref] : [])).slice(0, 2) : []
    const note = mark.note.length > NOTE_WORDS ? `${mark.note.slice(0, NOTE_WORDS)}…` : mark.note
    return { kind: 'mark', live: true, lights, plain: false, act: 'focus', author: mark.author, title: note === '' ? `Go to ${value}` : `${value}: ${note}` }
  }
  if (/^r\d+$/.test(value)) {
    const n = Number(value.slice(1))
    const shown = s.scene !== null && n === s.revision
    // The build on show is live while the build after it has failed: a click says why. An older build stays inert.
    const failed = shown && s.build?.status === 'failed' && s.build.error !== undefined
    const title = shown ? `Build ${value}, the one on show${failed ? '; the build after it failed: show why' : ''}` : `Build ${value}`
    return { kind: 'build', live: failed, lights: [], plain: n < 1 || n > s.revision, ...(failed ? { act: 'build' as const } : {}), title }
  }
  const sub = /^(.*)\/([FE])(\d+)$/.exec(value)
  if (!sub) return { kind: 'none', live: false, lights: [], plain: true, title: value }
  const [, name, letter, number] = sub
  const found = s.scene?.parts.find((p) => p.layout === s.layout && p.name === name)
  const no = (title: string): RefInfo => ({ kind: 'geometry', live: false, lights: [], plain: false, title })
  if (!found) {
    // A part the build has in no layout is not a part: the text names something else.
    const anywhere = s.scene?.parts.some((p) => p.name === name) === true
    return { ...no(`${value} is not in the layout shown (${s.layout})`), plain: !anywhere }
  }
  if (layerOf(s.layers, name)?.visible === false) return no(`${value} is on a part that is switched off`)
  if (Number(number) >= (letter === 'F' ? found.faceCount : found.edgeCount)) return no(`${name} has no ${letter}${number}`)
  return { kind: 'geometry', live: true, lights: [value], plain: false, act: 'select', title: `Select ${value}` }
}

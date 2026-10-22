import { offBy, shownDimension, valueAgainstExpected } from '../../shared/dimension'
import type { Mark } from '../../shared/marks'
import type { ViewportPointer } from '../viewport/Viewport'

/**
 * What a mark's chip in the view says at the pointer, after its number: the note, or for a dimension its numbers,
 * what was expected and by how much it misses (`40 mm, expected 42 ± 0.1, 2 under`), as its row says them.
 */
export function chipSays(mark: Mark, revision: number | undefined): string {
  if (mark.kind !== 'dimension') return mark.note === '' ? 'No note' : mark.note
  const shown = shownDimension(mark, revision)
  if (shown.value === undefined) return [shown.stale ? shown.text : '', shown.note ?? (shown.stale ? '' : shown.text)].filter(Boolean).join(', ')
  const against = valueAgainstExpected(mark, revision) ?? shown.text
  return shown.verdict === 'fail' && mark.expected !== undefined ? `${against}, ${offBy(shown.value, mark.expected)}` : against
}

/** What the chips of the marks need of the view they are drawn on. */
export interface ChipHost {
  /** The mark whose chip is under a point of the window, as the last frame drew the chips; null for none. */
  markAt(client: [number, number]): string | null
  /** The pointer went on a mark's chip, or off it (null): its row and its chip say so, and the cursor. */
  point(id: string | null): void
  /** What the chip the pointer is on says, at the pointer. Called with every move over it. */
  say(client: [number, number], id: string): void
  /** The chip was clicked: its mark is opened where it is. */
  open(id: string): void
}

/**
 * The chips of the marks in the view, answering the pointer before the tool in hand is handed it (`route` is true
 * for an event it took, which no tool is then told of). The pointer on a chip points at its mark; a click on one
 * opens it, whatever tool is in hand: a chip covers the part under it, so a click there is meant for the chip. A
 * drag that starts on a chip is the camera's, as a drag anywhere else is: the orbit is not asked, it listens on the
 * canvas itself, and the tool is handed nothing of it. A press that began beside a chip is the tool's to the end.
 */
export function markChips(host: ChipHost): { route(e: ViewportPointer): boolean; drop(): void } {
  /** The chip the pointer is on, while no button is held. */
  let over: string | null = null
  /** The chip a press began on, until the press ends; and the one released on, for the click that may follow. */
  let pressed: string | null = null
  let released: string | null = null

  const leave = (): void => {
    if (over === null) return
    over = null
    host.point(null)
  }

  return {
    route(e) {
      switch (e.type) {
        case 'cancel':
          leave()
          pressed = null
          released = null
          return false
        case 'move': {
          if (e.buttons !== 0) return pressed !== null
          const id = host.markAt(e.client)
          if (id !== over) {
            leave()
            if (id !== null) {
              over = id
              host.point(id)
            }
          }
          if (id === null) return false
          host.say(e.client, id)
          return true
        }
        case 'down':
          released = null
          pressed = host.markAt(e.client)
          // While a button is held nothing is pointed at: the camera may be turning.
          if (pressed !== null) leave()
          return pressed !== null
        case 'up':
          released = pressed
          pressed = null
          return released !== null
        case 'click': {
          const from = released
          released = null
          if (from === null) return false
          if (host.markAt(e.client) === from) host.open(from)
          return true
        }
      }
    },
    drop() {
      leave()
      pressed = null
      released = null
    }
  }
}

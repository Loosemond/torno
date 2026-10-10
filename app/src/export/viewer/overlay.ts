import type { ExportMark } from '../../shared/exportdata'
import type { Vec3 } from '../../shared/marks'

// The marks' labels, as elements over the canvas: a number, and of a dimension the value torno measured. Each
// is put where its point is drawn, every frame that is drawn; a dot marks the point, and of a dimension the two
// ends of its line. A label that would lie on one already placed goes under it. Text is set as text, never as
// markup.

export interface Label { mark: ExportMark; by: Vec3; dimmed: boolean }

export interface Overlay {
  set(labels: readonly Label[]): void
  place(project: (point: Vec3, by: Vec3) => { x: number; y: number; visible: boolean }): void
}

/** Where a label hangs from its point, in pixels: a little to the right and above. */
const OFF = { x: 7, y: -27 }
/** How many times a label gives way to those placed before it. */
const TRIES = 8

interface Shown { label: Label; chip: HTMLElement; dots: Array<{ at: Vec3; dot: HTMLElement }> }

export function createOverlay(root: HTMLElement): Overlay {
  let shown: Shown[] = []
  return {
    set(labels) {
      root.replaceChildren()
      shown = labels.map((label) => {
        const { mark } = label
        const dimmed = label.dimmed || mark.status === 'resolved'
        const chip = document.createElement('span')
        chip.className = 'chip'
        chip.dataset.author = mark.author
        chip.dataset.mark = mark.id
        if (dimmed) chip.dataset.dimmed = ''
        const id = document.createElement('span')
        id.className = 'num chip-id'
        id.textContent = mark.id
        chip.append(id)
        if (mark.kind === 'dimension' && mark.text !== undefined) {
          const value = document.createElement('span')
          value.className = 'num'
          value.textContent = mark.text
          chip.append(value)
          if (mark.verdict) {
            const verdict = document.createElement('span')
            verdict.className = 'verdict'
            verdict.dataset.verdict = mark.verdict
            verdict.textContent = mark.verdict === 'pass' ? '✓' : '✗'
            verdict.setAttribute('aria-label', mark.verdict === 'pass' ? 'passes' : 'fails')
            chip.append(verdict)
          }
        }
        // A dimension's line has an end at each of its two points; anything else has its one point.
        const ends = mark.kind === 'dimension' && mark.line && mark.line.length === 2 ? mark.line : [mark.at]
        const dots = ends.map((at) => {
          const dot = document.createElement('span')
          dot.className = 'dot'
          dot.dataset.author = mark.author
          if (dimmed) dot.dataset.dimmed = ''
          root.append(dot)
          return { at, dot }
        })
        root.append(chip)
        return { label, chip, dots }
      })
    },
    place(project) {
      const placed: Array<{ x: number; y: number; w: number; h: number }> = []
      for (const { label, chip, dots } of shown) {
        for (const { at, dot } of dots) {
          const end = project(at, label.by)
          dot.hidden = !end.visible
          if (end.visible) dot.style.transform = `translate(${end.x.toFixed(1)}px, ${end.y.toFixed(1)}px)`
        }
        const at = project(label.mark.at, label.by)
        chip.hidden = !at.visible
        if (!at.visible) continue
        const box = { x: at.x + OFF.x, y: at.y + OFF.y, w: chip.offsetWidth, h: chip.offsetHeight }
        // Under whichever label it would cover, and under the next, a few times: then it stays where it is.
        for (let n = 0; n < TRIES; n++) {
          const under = placed.find((one) => box.x < one.x + one.w && one.x < box.x + box.w && box.y < one.y + one.h && one.y < box.y + box.h)
          if (!under) break
          box.y = under.y + under.h + 2
        }
        placed.push(box)
        chip.style.transform = `translate(${box.x.toFixed(1)}px, ${box.y.toFixed(1)}px)`
      }
    }
  }
}

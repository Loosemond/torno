import type { ExportMark } from '../../shared/exportdata'
import type { Vec3 } from '../../shared/marks'

// The marks' labels, as elements over the canvas: a number, and of a dimension the value torno measured. Each
// is put where its point is drawn, every frame that is drawn. Text is set as text, never as markup.

export interface Label { mark: ExportMark; by: Vec3; dimmed: boolean }

export interface Overlay {
  set(labels: readonly Label[]): void
  place(project: (point: Vec3, by: Vec3) => { x: number; y: number; visible: boolean }): void
}

export function createOverlay(root: HTMLElement): Overlay {
  let shown: Array<{ label: Label; chip: HTMLElement }> = []
  return {
    set(labels) {
      root.replaceChildren()
      shown = labels.map((label) => {
        const { mark } = label
        const chip = document.createElement('span')
        chip.className = 'chip'
        chip.dataset.author = mark.author
        chip.dataset.mark = mark.id
        if (label.dimmed || mark.status === 'resolved') chip.dataset.dimmed = ''
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
        root.append(chip)
        return { label, chip }
      })
    },
    place(project) {
      for (const { label, chip } of shown) {
        const at = project(label.mark.at, label.by)
        chip.hidden = !at.visible
        if (at.visible) chip.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`
      }
    }
  }
}

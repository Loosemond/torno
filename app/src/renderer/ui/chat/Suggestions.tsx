import { numbered } from '../numbered'
import type { Suggestion } from './suggest'

/**
 * A row of quiet chips above the box: the next useful prompts for the state the project is in. A chip fills the box
 * and gives it the keys, so the person can add to it; it never sends.
 */
export function Suggestions({ chips, onChoose }: { chips: readonly Suggestion[]; onChoose: (chip: Suggestion) => void }) {
  if (chips.length === 0) return null
  return (
    <div className="chat-suggest" role="group" aria-label="Suggestions">
      {chips.map((chip) => (
        <button key={chip.id} type="button" className="chat-suggest-chip" data-suggest={chip.id} onClick={() => onChoose(chip)}>
          {numbered(chip.label)}
        </button>
      ))}
    </div>
  )
}

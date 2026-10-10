/**
 * Where a key press belongs to something else: a field to type in, or the
 * session's terminal. A slider or a tick box is an `input` that takes no
 * letters: with one in focus, as the section's slider is after a drag, the
 * keys of the tools are still the tools'.
 */
export const TYPING = 'input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable], [data-region="session"]'

/**
 * A field is done with (Enter kept what was typed, Escape left it as it was): the keys go back to the view.
 * The focus leaves the field for the page itself, where every key of the tools and the viewport is listened
 * to; the letter pressed next takes a tool in hand and is not typed into the field.
 */
export function giveKeysBack(field: HTMLElement): void {
  field.blur()
}

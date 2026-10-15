/**
 * Where a key press belongs to something else: a field to type in, a list being chosen in, or the session
 * pane, where its terminal lives. A slider or a tick box is an `input` that takes no letters: with one in
 * focus, as the section's slider is after a drag, the keys of the tools are still the tools'. What only the
 * pointer took up there gives the keys back when it is done with: the pane's edge once dragged, its agent
 * picker once chosen in (`chosen`).
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

/** The lists (`select`) last pressed on with the pointer: a choice made there is made with the pointer. */
const pointed = new WeakSet<Element>()

/**
 * What a list (`select`) is given so that a choice in it gives the keys back to the view when it was made with
 * the pointer (`chosen`); one made with the keys leaves them in the list, for the next arrow.
 */
export const pointerChoice = {
  onPointerDown: (e: { currentTarget: Element }): void => void pointed.add(e.currentTarget),
  onKeyDown: (e: { currentTarget: Element }): void => void pointed.delete(e.currentTarget)
}

/**
 * A choice was made in a list (its `change`). Made with the pointer, it is done with, as a field is on Enter:
 * the keys go back to the view, and the next letter takes a tool in hand rather than choosing in the list.
 */
export function chosen(list: HTMLElement): void {
  if (!pointed.has(list)) return
  pointed.delete(list)
  giveKeysBack(list)
}

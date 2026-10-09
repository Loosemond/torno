/**
 * What a key does for someone working on torno itself, in place of the menu
 * torno does not have: F12 or Ctrl+Shift+I opens the developer tools, and,
 * where `allow.reload` says so (under the dev server only: in the app as
 * built, Ctrl+R and F5 are keys of the agent's CLI), F5 or Ctrl+R reloads the
 * window. Null for any other key.
 */
export function devShortcut(
  input: { type: string; key: string; control: boolean; shift: boolean; alt: boolean; meta: boolean },
  allow: { reload: boolean }
): 'reload' | 'devtools' | null {
  if (input.type !== 'keyDown' || input.alt || input.meta) return null
  const key = input.key.toLowerCase()
  if (allow.reload && key === 'f5' && !input.control && !input.shift) return 'reload'
  if (allow.reload && key === 'r' && input.control && !input.shift) return 'reload'
  if (key === 'f12' && !input.control && !input.shift) return 'devtools'
  if (key === 'i' && input.control && input.shift) return 'devtools'
  return null
}

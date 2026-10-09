/**
 * What a key does for someone working on torno itself, in place of the menu
 * torno does not have: F5 or Ctrl+R reloads the window, F12 or Ctrl+Shift+I
 * opens the developer tools. Null for any other key.
 */
export function devShortcut(input: { type: string; key: string; control: boolean; shift: boolean; alt: boolean; meta: boolean }): 'reload' | 'devtools' | null {
  if (input.type !== 'keyDown' || input.alt || input.meta) return null
  const key = input.key.toLowerCase()
  if (key === 'f5' && !input.control && !input.shift) return 'reload'
  if (key === 'r' && input.control && !input.shift) return 'reload'
  if (key === 'f12' && !input.control && !input.shift) return 'devtools'
  if (key === 'i' && input.control && input.shift) return 'devtools'
  return null
}

import { pressed } from '../shared/keys'

/**
 * What a key does for someone working on torno itself, in place of the menu
 * torno does not have: F12 or Ctrl+Shift+I opens the developer tools, and,
 * where `allow.reload` says so (under the dev server only: in the app as
 * built, Ctrl+R and F5 are keys of the agent's CLI), F5 or Ctrl+R reloads the
 * window. Null for any other key. Which keys those are is the table's to say
 * (`shared/keys.ts`, rows `devtools` and `reload`).
 */
export function devShortcut(
  input: { type: string; key: string; control: boolean; shift: boolean; alt: boolean; meta: boolean },
  allow: { reload: boolean }
): 'reload' | 'devtools' | null {
  if (input.type !== 'keyDown') return null
  const press = { key: input.key, ctrlKey: input.control, shiftKey: input.shift, altKey: input.alt, metaKey: input.meta }
  if (allow.reload && pressed(press, 'reload')) return 'reload'
  if (pressed(press, 'devtools')) return 'devtools'
  return null
}

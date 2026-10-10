import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { GIZMO_MODES, TOOLS } from '../renderer/state/tools'
import { EXPLODED_TOOLS } from './explode'
import { CONTEXTS, GIZMO_KEYS, KEYS, TOOL_KEYS, VIEW_KEYS, cheatSheet, hint, keyClashes, keyName, pressed, typed, which, type KeyRow } from './keys'

it('is where the tools, the views and the gizmo have their keys from', () => {
  expect(TOOLS.map((t) => [t.name, t.label, t.key])).toEqual(TOOL_KEYS.map((t) => [t.name, t.label, t.key]))
  expect(GIZMO_MODES.map((m) => [m.mode, m.key])).toEqual(GIZMO_KEYS.map((m) => [m.mode, m.key]))
  expect(TOOL_KEYS.map((t) => t.key).join('')).toBe('VPADSXMLB')
  expect(VIEW_KEYS.map((v) => v.key).join('')).toBe('1234')
})

it('lists every tool, every view key and the gizmo in the sheet, each key once where it is listened to', () => {
  const sheet = cheatSheet()
  expect(sheet.map((g) => g.context)).toEqual(['Everywhere', 'Viewport', 'With a tool in hand', 'With a shape in hand', 'Page of objects', 'Session', 'In a field, a menu or a sheet'])
  expect(sheet.map((g) => g.context)).toEqual(CONTEXTS.map((c) => c.name))
  for (const group of sheet) expect([group.context, group.rows.length > 0, group.when.length > 0]).toEqual([group.context, true, true])
  const viewport = KEYS.filter((row) => row.scope === 'viewport').flatMap((row) => row.keys)
  for (const key of ['V', 'P', 'A', 'D', 'S', 'X', 'M', 'L', 'B', '1', '2', '3', '4', 'F', 'O', 'E', 'W', 'Esc']) expect([key, viewport.filter((k) => k === key).length]).toEqual([key, 1])
  expect(KEYS.filter((row) => row.keys.includes('?')).map((row) => row.scope)).toEqual(['window'])
  expect(keyClashes()).toEqual([])
  // E is the Region tool's own while it is in hand, and explode otherwise: two scopes, no clash.
  expect(KEYS.filter((row) => row.keys.includes('E')).map((row) => row.scope).sort()).toEqual(['region', 'viewport'])
  // A row that is not shown is still a row: it is held to the same rules.
  expect(sheet.flatMap((g) => g.rows).some((row) => row.hidden)).toBe(false)
  expect(KEYS.some((row) => row.hidden)).toBe(true)
  // Every row says what it does, in sentence case, and has an id of its own.
  for (const row of KEYS) expect([row.id, /^[A-Z]/.test(row.does), row.keys.length > 0]).toEqual([row.id, true, true])
  expect(new Set(KEYS.map((row) => row.id)).size).toBe(KEYS.length)
})

/** The files the exported page's viewer is made of must not bring the table in: it would be in every exported file. */
it('is not in the exported page', () => {
  const viewer = resolve(__dirname, '../export')
  for (const file of sources(viewer)) expect([file, /shared\/keys'/.test(readFileSync(file, 'utf8'))]).toEqual([file, false])
})

const extra = (keys: string[], scope: KeyRow['scope']): KeyRow => ({ id: 'explode', keys, does: 'Something else', context: 'Viewport', scope })

it('finds a key given twice in one scope, and one heard everywhere that something else has too', () => {
  expect(keyClashes([...KEYS, extra(['F'], 'viewport')])).toEqual(['F (viewport)'])
  expect(keyClashes([extra(['Z'], 'region'), extra(['Z'], 'region')])).toEqual(['Z (region)'])
  // A key of two tools is each tool's own.
  expect(keyClashes([extra(['Z'], 'region'), extra(['Z'], 'align')])).toEqual([])
  // What is heard while typing, or anywhere outside a field, is nobody else's.
  expect(keyClashes([...KEYS, extra(['Ctrl+Shift+E'], 'session')])).toEqual(['Ctrl+Shift+E (global, session)'])
  expect(keyClashes([...KEYS, extra(['?'], 'page')])).toEqual(['? (window, page)'])
})

it('names a key press as the table does', () => {
  expect(keyName({ key: 'v' })).toBe('V')
  expect(keyName({ key: 'V', shiftKey: true })).toBe('V')
  expect(keyName({ key: '?', shiftKey: true })).toBe('?')
  expect(keyName({ key: 'Escape' })).toBe('Esc')
  expect(keyName({ key: 'ArrowLeft', shiftKey: true })).toBe('Shift+Left')
  expect(keyName({ key: 'Enter', shiftKey: true })).toBe('Shift+Enter')
  // A chord is named by the key's place, whatever character the layout and the modifiers make of it.
  expect(keyName({ key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+E')
  expect(keyName({ key: '\u0005', code: 'KeyE', ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+E')
  expect(keyName({ key: '`', code: 'Backquote', ctrlKey: true })).toBe('Ctrl+`')
  expect(keyName({ key: 'I', ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+I')
  expect(keyName({ key: 'F12' })).toBe('F12')
})

it('says which key of a row was pressed', () => {
  expect(pressed({ key: 'f' }, 'fit')).toBe(true)
  expect(pressed({ key: 'f', ctrlKey: true }, 'fit')).toBe(false)
  expect(pressed({ key: 'Escape' }, 'escape')).toBe(true)
  expect(which({ key: '[' }, 'region.brush')).toBe(0)
  expect(which({ key: ']' }, 'region.brush')).toBe(1)
  expect(which({ key: 'x' }, 'region.brush')).toBe(-1)
  expect(which({ key: '3' }, 'views')).toBe(2)
  expect(which({ key: 'r' }, 'gizmo')).toBe(1)
  // Shift with a key is that key, unless Shift with it is a row of its own where it is listened to.
  expect(pressed({ key: 'Tab', shiftKey: true }, 'align.first')).toBe(true)
  expect(pressed({ key: 'Escape', shiftKey: true }, 'escape')).toBe(true)
  expect(which({ key: 'ArrowRight' }, 'section.step')).toBeGreaterThanOrEqual(0)
  expect(which({ key: 'ArrowRight', shiftKey: true }, 'section.step')).toBe(-1)
  expect(which({ key: 'ArrowRight', shiftKey: true }, 'section.fine')).toBeGreaterThanOrEqual(0)
  expect(pressed({ key: 'Enter', shiftKey: true }, 'field.keep')).toBe(false)
  expect(pressed({ key: 'Enter' }, 'field.keep')).toBe(true)
})

it('gives the key of a row for a tooltip', () => {
  // Written out where the table may not be brought in (the exported page's viewer is bundled with that file): held to it here.
  expect(EXPLODED_TOOLS).toContain(`(${hint('explode')}, or the slider at 0)`)
  expect(readFileSync(resolve(__dirname, 'explode.ts'), 'utf8')).not.toContain("from './keys'")
  expect(hint('fit')).toBe('F')
  expect(hint('tool.pin')).toBe('P')
  expect(hint('export')).toBe('Ctrl+Shift+E')
  expect(hint('gizmo', 2)).toBe('T')
})

it('has nothing heard while typing that typing or the terminal would take', () => {
  for (const key of ['V', '?', 'Esc', 'Enter', 'Shift+Enter', 'Left', 'Ctrl+C', 'Ctrl+R', 'Ctrl+E']) expect([key, typed(key)]).toEqual([key, true])
  for (const key of ['Ctrl+Shift+E', 'Ctrl+`', 'F12', 'Ctrl+Shift+I']) expect([key, typed(key)]).toEqual([key, false])
  const global = KEYS.filter((row) => row.scope === 'global')
  expect(global.map((row) => row.id)).toEqual(['session.focus', 'export', 'devtools'])
  for (const row of global) for (const key of row.keys) expect([key, typed(key)]).toEqual([key, false])
  // And nothing that is listened to only outside a field needs a chord to be told from typing.
  for (const row of KEYS.filter((r) => r.scope === 'viewport' || r.scope === 'window')) for (const key of row.keys) expect([key, typed(key)]).toEqual([key, true])
})

/** Every source of the window and of main that is not a test. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.(test|itest)\.tsx?$/.test(entry.name) ? [path] : []
  })
}

const src = resolve(__dirname, '..')
const files = [...sources(join(src, 'renderer')), ...sources(join(src, 'main')), ...sources(join(src, 'preload'))]

it('is the only place a key is named: no handler compares a key with a name of its own', () => {
  // A key of the keyboard as the DOM names it, or a key compared with any text at all.
  const named = /['"`](?:Escape|Arrow(?:Left|Right|Up|Down)|Backquote|Backspace|Key[A-Z]|F\d{1,2})['"`]/
  const compared = /(?:\.key|\bkey|keyName\([^)]*\))(?:\.to(?:Upper|Lower)Case\(\))?\s*[!=]==?\s*['"`]/
  const found: string[] = []
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      // In main a `key` is also a key of an object: there only the keys of the keyboard are looked for, and in the file that hears them.
      const hears = !file.includes(`${join('src', 'main')}`) || file.endsWith('devkeys.ts')
      if (named.test(line) || (hears && compared.test(line))) found.push(`${relative(src, file)}:${i + 1}: ${line.trim()}`)
    })
  }
  expect(found).toEqual([])
  expect(files.length).toBeGreaterThan(100)
})

it('is where every key shown on a button or in a tooltip comes from', () => {
  // A key cap with its text written out, a shortcut given as text, or a key in brackets at the end of a title.
  // Or a key named in a sentence: "E puts them together", "Press T".
  const written = [/<kbd[^>]*>\s*[^\s{<]/, /aria-keyshortcuts="/, /\((?:[A-Z?/]|Esc|Enter|Tab|Ctrl\+[^)]*|Shift\+[^)]*)\)/, /['"`>][^'"`<\n]*\b[Pp]ress(?:ing)? (?:[A-Z]|Esc|Enter|Tab)\b/, /['"`>· ]\b[A-Z] (?:puts|shows|takes|opens|closes)\b/]
  const found: string[] = []
  for (const file of files.filter((f) => f.includes(`${join('src', 'renderer')}`))) {
    const text = readFileSync(file, 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')
    for (const pattern of written) {
      const hit = pattern.exec(text)
      if (hit) found.push(`${relative(src, file)}: ${hit[0]}`)
    }
  }
  expect(found).toEqual([])
})

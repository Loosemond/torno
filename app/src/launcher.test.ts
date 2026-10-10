import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'

const scripts = resolve(__dirname, '../../scripts')
const script = join(scripts, 'torno')
const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/**
 * With a HOME and a data folder of its own, so that nothing of the person's is read or written whatever the
 * script does. No test here runs it against the real home.
 */
function run(args: string[], env: Record<string, string> = {}, from = script) {
  const home = mkdtempSync(join(tmpdir(), 'torno-launcher-'))
  made.push(home)
  const result = spawnSync('sh', [from, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home, XDG_DATA_HOME: join(home, 'data'), ...env } })
  return { ...result, home }
}

/** Every file under a folder, by its path from it. */
const files = (dir: string): string[] => (existsSync(dir) ? (readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1)).sort()) : [])

it('says the command it would start, with a platform only when one is asked for, and starts nothing', () => {
  const plain = run(['--print-command'])
  expect(plain.status).toBe(0)
  const lines = plain.stdout.trim().split('\n')
  expect(lines[0].endsWith('/app/node_modules/.bin/electron')).toBe(true)
  expect(lines[1].endsWith('/app')).toBe(true)
  expect(lines).toHaveLength(2)
  expect(run(['--print-command'], { TORNO_OZONE: 'wayland' }).stdout.trim().split('\n').at(-1)).toBe('--ozone-platform=wayland')
  expect(run(['--print-command'], { TORNO_OZONE: 'x11' }).stdout.trim().split('\n').at(-1)).toBe('--ozone-platform=x11')
  // Never with the test switch, whatever is asked.
  expect(run(['--print-command'], { TORNO_OZONE: 'wayland', TORNO_TEST: '1' }).stdout).not.toContain('ozone')
  // With a folder it is the same command: the folder goes in the environment. One that is no folder is refused as at a start.
  expect(run(['--print-command', plain.home]).stdout).toBe(plain.stdout)
  const missing = run(['--print-command', join(plain.home, 'nowhere')])
  expect([missing.status, missing.stdout]).toEqual([2, ''])
  expect(missing.stderr).toContain('not a folder')
  // Nothing was installed, built or written for the asking.
  expect(files(plain.home)).toEqual([])
})

it('refuses the headless platform, and any other it does not know, before it does anything', () => {
  for (const value of ['headless', 'drm', '']) {
    const refused = run(['--print-command'], { TORNO_OZONE: value })
    expect([value, refused.status]).toEqual([value, value === '' ? 0 : 2])
    if (value !== '') expect(refused.stderr).toContain('TORNO_OZONE must be wayland or x11 (headless is not supported')
    if (value !== '') expect(refused.stdout).toBe('')
  }
  // Whoever asks: also a test run, and also for a desktop entry.
  expect(run(['--print-command'], { TORNO_OZONE: 'headless', TORNO_TEST: '1' }).status).toBe(2)
  expect(run(['--print-desktop'], { TORNO_OZONE: 'headless' }).status).toBe(2)
})

it('prints a desktop entry that starts this script with the folder it is given, and writes nothing for the asking', () => {
  const printed = run(['--print-desktop'])
  expect(printed.status).toBe(0)
  const lines = printed.stdout.trim().split('\n')
  expect(lines[0]).toBe('[Desktop Entry]')
  expect(lines).toContain(`Exec="${script}" %F`)
  // Its icon is the repository's own file, by its whole path: nothing is copied anywhere for it.
  expect(lines).toContain(`Icon=${join(scripts, 'torno.svg')}`)
  expect(lines).toContain('Type=Application')
  expect(lines).toContain('Name=torno')
  expect(lines).toContain('Terminal=false')
  expect(printed.stdout).not.toContain('@')
  // The platform is the launcher's to decide when it runs, from TORNO_OZONE: the entry names none.
  expect(run(['--print-desktop'], { TORNO_OZONE: 'wayland' }).stdout).toBe(printed.stdout)
  expect(printed.stdout).not.toMatch(/ozone|headless|wayland|x11/)
  // It does not make torno an application for folders: a file manager would offer it for every one.
  expect(printed.stdout).not.toContain('MimeType')
  expect(files(printed.home)).toEqual([])
})

it('quotes a path the desktop entry could misread', () => {
  // A copy of the launcher in a folder whose name has a space, a dollar, a quote, a backslash and a per cent.
  const odd = mkdtempSync(join(tmpdir(), 'torno launcher $HOME "q" 50% \\-'))
  made.push(odd)
  cpSync(scripts, join(odd, 'scripts'), { recursive: true })
  const printed = run(['--print-desktop'], {}, join(odd, 'scripts', 'torno'))
  expect(printed.status).toBe(0)
  const exec = printed.stdout.split('\n').find((line) => line.startsWith('Exec='))!
  // Quoted, the four characters the specification names escaped, then every backslash doubled as in any string of the file; a per cent is two.
  const quoted = `${odd}/scripts/torno`.replace(/[\\"`$]/g, '\\$&').replace(/\\/g, '\\\\').replace(/%/g, '%%')
  expect(exec).toBe(`Exec="${quoted}" %F`)
  expect(printed.stdout.split('\n')).toContain(`Icon=${`${odd}/scripts/torno.svg`.replace(/\\/g, '\\\\')}`)
})

it('installs one file, under the data folder it is given, after saying what, and takes it away again', () => {
  const installed = run(['--install-desktop'])
  expect(installed.status).toBe(0)
  const entry = join(installed.home, 'data', 'applications', 'torno.desktop')
  // That file and no other: no icon is copied, no cache is made.
  expect(files(installed.home)).toEqual(['data/applications/torno.desktop'])
  const printed = run(['--print-desktop']).stdout
  expect(readFileSync(entry, 'utf8')).toBe(printed)
  // Said before it is written: the path, then the entry.
  expect(installed.stdout.startsWith(`torno: writing ${entry}\n`)).toBe(true)
  expect(installed.stdout).toContain(printed)
  expect(installed.stdout).toContain('Run it again after moving the repository.')

  // Without XDG_DATA_HOME it is ~/.local/share, of the HOME it is given.
  const home = mkdtempSync(join(tmpdir(), 'torno-launcher-home-'))
  made.push(home)
  const plain = spawnSync('sh', [script, '--install-desktop'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home } })
  expect(plain.status).toBe(0)
  expect(files(home)).toEqual(['.local/share/applications/torno.desktop'])
  const removed = spawnSync('sh', [script, '--uninstall-desktop'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home } })
  expect(removed.status).toBe(0)
  expect(removed.stdout).toContain(join(home, '.local/share/applications/torno.desktop'))
  expect(files(home)).toEqual([])
})

it('installs nothing as root, nor without a home', () => {
  // An `id` that says root, first on the PATH: the script is not run as root to see this.
  const bin = mkdtempSync(join(tmpdir(), 'torno-launcher-bin-'))
  made.push(bin)
  writeFileSync(join(bin, 'id'), '#!/bin/sh\necho 0\n')
  chmodSync(join(bin, 'id'), 0o755)
  const root = run(['--install-desktop'], { PATH: `${bin}:${process.env.PATH ?? ''}` })
  expect(root.status).toBe(2)
  expect(root.stderr).toContain('not as root')
  expect(files(root.home)).toEqual([])
  const homeless = spawnSync('sh', [script, '--install-desktop'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } })
  expect(homeless.status).toBe(2)
  expect(homeless.stderr).toContain('neither XDG_DATA_HOME nor HOME')
  // More than the option is a mistake, not a folder to open.
  const more = run(['--install-desktop', 'extra'])
  expect(more.status).toBe(2)
  expect(files(more.home)).toEqual([])
})

it('still says how it is used', () => {
  const help = execFileSync('sh', [script, '--help'], { encoding: 'utf8' })
  for (const word of ['usage: torno [workspace]', '--print-command', '--install-desktop', '--uninstall-desktop', '--print-desktop', 'TORNO_OZONE']) expect(help).toContain(word)
})

it('has an icon of its own: the accent on the paper grey, and nothing else', () => {
  const svg = readFileSync(join(scripts, 'torno.svg'), 'utf8')
  const tokens = readFileSync(resolve(__dirname, 'renderer/styles/tokens.css'), 'utf8')
  const light = tokens.slice(0, tokens.indexOf('@media (prefers-color-scheme: dark)'))
  const token = (name: string): string => new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(light)![1].toUpperCase()
  const colours = [...new Set([...svg.matchAll(/#[0-9A-Fa-f]{6}\b/g)].map((m) => m[0].toUpperCase()))].sort()
  expect(colours).toEqual([token('--accent'), token('--surface')].sort())
  expect(svg).toContain('viewBox="0 0 64 64"')
  expect(svg).not.toMatch(/<(script|image|text)|href=/)
})

it('builds again when a script of the build or the viewer of exported pages is newer or missing', () => {
  const text = readFileSync(script, 'utf8')
  for (const part of ['"$app/scripts"', '"$app/out/viewer/viewer.js"', '"$app/src"']) expect(text).toContain(part)
  // And what it starts is what it prints: the command is made once.
  expect(text.match(/node_modules\/\.bin\/electron/g)).toHaveLength(1)
})

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
  expect(run(['--print-command', plain.home]).stdout.endsWith(plain.stdout)).toBe(true)
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
  expect(lines).toContain(`Exec="${script}" --from-desktop %F`)
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
  expect(exec).toBe(`Exec="${quoted}" --from-desktop %F`)
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

it('builds again when a script of the build or the viewer of exported pages changes or is missing', () => {
  const text = readFileSync(script, 'utf8')
  for (const part of [' app/scripts ', '"$app/out/viewer/viewer.js"', 'find app/src ']) expect(text).toContain(part)
  // And what it starts is what it prints: the command is made once.
  expect(text.match(/node_modules\/\.bin\/electron/g)).toHaveLength(1)
})

// The polish review's minors M8 to M11, and the one identity.
it('says how it is used whatever platform is asked for: the help is where the variable is explained', () => {
  const help = run(['--help'], { TORNO_OZONE: 'headless' })
  expect(help.status).toBe(0)
  expect(help.stdout).toContain('TORNO_OZONE')
  expect(help.stdout).toContain('usage: torno [workspace]')
})

it('prints the folder with the command it would start: all of what is started', () => {
  const plain = run(['--print-command'])
  const folder = run(['--print-command', plain.home])
  expect(folder.status).toBe(0)
  const lines = folder.stdout.trim().split('\n')
  expect(lines[0]).toMatch(/^TORNO_WORKSPACE=.*torno-launcher-/)
  expect(lines.slice(1).join('\n')).toBe(plain.stdout.trim())
  // None was given: none is printed.
  expect(plain.stdout).not.toContain('TORNO_WORKSPACE')
})

it('says so when it replaces an entry that is there', () => {
  const first = run(['--install-desktop'])
  expect(first.stdout).toContain('torno: writing ')
  const again = spawnSync('sh', [script, '--install-desktop'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: first.home, XDG_DATA_HOME: join(first.home, 'data') } })
  expect(again.status).toBe(0)
  expect(again.stdout).toContain(`torno: replacing ${join(first.home, 'data', 'applications', 'torno.desktop')}`)
})

it('shows what went wrong when it was started from the desktop entry, where nobody reads its errors: a notice, or a log under its own data', () => {
  // The entry says where it was started from; a folder that is none is the failure at hand.
  expect(run(['--print-desktop']).stdout).toMatch(/^Exec="[^"]*scripts\/torno" --from-desktop %F$/m)
  const home = mkdtempSync(join(tmpdir(), 'torno-launcher-'))
  made.push(home)
  const bin = join(home, 'bin')
  cpSync(scripts, join(home, 'scripts'), { recursive: true })
  // A PATH with the tools of a shell and no notify-send: it is logged.
  const env = { PATH: '/usr/bin:/bin', HOME: home, XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state') }
  const hasNotify = spawnSync('sh', ['-c', 'command -v notify-send'], { env }).status === 0
  const failed = spawnSync('sh', [script, '--from-desktop', join(home, 'nowhere')], { encoding: 'utf8', env: { ...env, TORNO_NOTIFY: join(bin, 'none') } })
  expect(failed.status).toBe(2)
  expect(failed.stderr).toContain('not a folder')
  const log = join(home, 'state', 'torno', 'launcher.log')
  expect(readFileSync(log, 'utf8')).toMatch(/torno: not a folder: .*nowhere/)
  // With a notifier it is shown, and nothing is logged for it.
  rmSync(log)
  const said = join(home, 'said.txt')
  const notify = join(home, 'notify')
  writeFileSync(notify, `#!/bin/sh\nprintf '%s\\n' "$@" > '${said}'\n`)
  chmodSync(notify, 0o755)
  spawnSync('sh', [script, '--from-desktop', join(home, 'nowhere')], { encoding: 'utf8', env: { ...env, TORNO_NOTIFY: notify } })
  expect(readFileSync(said, 'utf8')).toContain('not a folder')
  expect(existsSync(log)).toBe(false)
  // Started from a terminal (no such flag), nothing is shown or logged anywhere: the error is on stderr, where it is read.
  const plain = spawnSync('sh', [script, join(home, 'nowhere')], { encoding: 'utf8', env: { ...env, TORNO_NOTIFY: notify } })
  expect(plain.status).toBe(2)
  expect(existsSync(log)).toBe(false)
  void hasNotify
})

it('has one identity: the mark in the window is the drawing of the icon', () => {
  const icon = readFileSync(join(scripts, 'torno.svg'), 'utf8')
  const profile = /<path d="(M9 27[^"]*)"/.exec(icon)![1]
  const window = readFileSync(resolve(__dirname, 'renderer/ui/ViewportPane.tsx'), 'utf8')
  expect(window).toContain(`d="${profile}"`)
  // Its centre line holds at the size of a launcher: 2 wide, a plain dash.
  expect(icon).toMatch(/<path d="M4 32H60"[^>]*stroke-width="2"[^>]*stroke-dasharray="6 4"/)
  expect(readFileSync(join(scripts, 'torno.desktop.in'), 'utf8')).toContain('StartupWMClass=torno')
  // And the window says whose it is, so that the desktop finds its entry and its icon.
  const main = readFileSync(resolve(__dirname, 'main/index.ts'), 'utf8')
  expect(main).toContain("app.setName('torno')")
  expect(main).toContain("setDesktopName?.('torno.desktop')")
})

/**
 * A repository of its own beside a copy of the launcher: a source or two, the build's files, `node_modules`, an
 * Electron that only says it was started and a `pnpm` that only says it built (and writes the build's files). The
 * launcher is run against that, never against this repository's `app/out`.
 */
function fakeRepository() {
  const root = mkdtempSync(join(tmpdir(), 'torno-launcher-repo-'))
  made.push(root)
  cpSync(scripts, join(root, 'scripts'), { recursive: true })
  const app = join(root, 'app')
  const write = (path: string, text: string, mode?: number): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
    if (mode !== undefined) chmodSync(join(root, path), mode)
  }
  write('app/src/main/index.ts', 'export const a = 1\n')
  write('app/src/renderer/ui/Thing.tsx', 'export const b = 2\n')
  write('app/scripts/build-viewer.mjs', '// the viewer\n')
  write('app/package.json', '{}\n')
  write('app/electron.vite.config.ts', 'export default {}\n')
  write('app/tsconfig.json', '{}\n')
  write('pnpm-lock.yaml', 'lockfileVersion: 9\n')
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  write('app/node_modules/.bin/electron', `#!/bin/sh\necho started >> '${join(root, 'started.log')}'\n`, 0o755)
  // `pnpm build`: says it built, then writes what a build writes. FAIL=1 in its folder makes it fail; EDIT names a
  // source it changes while it runs, as a person saving during a build would.
  write(
    'bin/pnpm',
    `#!/bin/sh\necho "$*" >> '${join(root, 'built.log')}'\n` +
      `[ ! -f '${join(root, 'bin/EDIT')}' ] || echo '// saved during the build' >> "$(cat '${join(root, 'bin/EDIT')}')"\n` +
      `[ ! -f '${join(root, 'bin/FAIL')}' ] || exit 1\n` +
      `cd '${app}' && mkdir -p out/main out/preload out/renderer out/viewer && touch out/main/index.js out/preload/index.js out/renderer/index.html out/viewer/viewer.js\n`,
    0o755,
  )
  write('bin/uv', '#!/bin/sh\nexit 0\n', 0o755)
  const path = `${join(root, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`
  const start = () => {
    const before = existsSync(join(root, 'built.log')) ? readFileSync(join(root, 'built.log'), 'utf8').split('\n').length : 1
    const result = spawnSync('sh', [join(root, 'scripts', 'torno')], { encoding: 'utf8', env: { PATH: path, HOME: join(root, 'home'), XDG_DATA_HOME: join(root, 'home', 'data') } })
    const after = existsSync(join(root, 'built.log')) ? readFileSync(join(root, 'built.log'), 'utf8').split('\n').length : 1
    return { status: result.status, stderr: result.stderr, built: after > before }
  }
  return { root, app, write, start }
}

it('builds again when what a source says changes, and not when only its time does', () => {
  const repo = fakeRepository()
  const first = repo.start()
  expect([first.status, first.built]).toEqual([0, true])
  // The stamp is what the sources hold, not a time.
  expect(readFileSync(join(repo.app, 'out', '.built'), 'utf8')).toMatch(/^[0-9a-f]{64}\n$/)
  expect(repo.start().built).toBe(false)
  // A checkout or a touch that leaves every source as it was: newer files, the same content.
  const later = new Date(Date.now() + 60_000)
  for (const source of ['app/src/main/index.ts', 'app/scripts/build-viewer.mjs', 'pnpm-lock.yaml']) utimesSync(join(repo.root, source), later, later)
  expect(repo.start().built).toBe(false)
  // A stamp older than everything says nothing either.
  utimesSync(join(repo.app, 'out', '.built'), new Date(0), new Date(0))
  expect(repo.start().built).toBe(false)
  // What a source says, in each place the build reads.
  for (const [source, text] of [['app/src/renderer/ui/Thing.tsx', 'export const b = 3\n'], ['app/scripts/build-viewer.mjs', '// another viewer\n'], ['app/package.json', '{ "a": 1 }\n'], ['pnpm-lock.yaml', 'lockfileVersion: 10\n']]) {
    repo.write(source, text)
    expect([source, repo.start().built]).toEqual([source, true])
    expect([source, repo.start().built]).toEqual([source, false])
  }
  // A new source, and one taken away, are changes too; so is one that only changed its name.
  repo.write('app/src/shared/new.ts', 'export {}\n')
  expect(repo.start().built).toBe(true)
  renameSync(join(repo.root, 'app/src/shared/new.ts'), join(repo.root, 'app/src/shared/renamed.ts'))
  expect(repo.start().built).toBe(true)
  rmSync(join(repo.root, 'app/src/shared/renamed.ts'))
  expect(repo.start().built).toBe(true)
  expect(repo.start().built).toBe(false)
  // What the build wrote, gone: built again whatever the stamp says.
  rmSync(join(repo.app, 'out', 'viewer', 'viewer.js'))
  expect(repo.start().built).toBe(true)
})

it('keeps no stamp of a build that failed, nor one of sources saved while it ran', () => {
  const repo = fakeRepository()
  expect(repo.start().built).toBe(true)
  const stamp = readFileSync(join(repo.app, 'out', '.built'), 'utf8')
  repo.write('app/src/main/index.ts', 'export const a = 2\n')
  repo.write('bin/FAIL', '')
  const failed = repo.start()
  expect([failed.status, failed.built]).toEqual([1, true])
  expect(failed.stderr).toContain('building the app failed')
  // The stamp is still of the last build that succeeded: the next start tries again.
  expect(readFileSync(join(repo.app, 'out', '.built'), 'utf8')).toBe(stamp)
  rmSync(join(repo.root, 'bin/FAIL'))
  expect(repo.start().built).toBe(true)
  expect(repo.start().built).toBe(false)
  // A source saved during a build is not what was built: the stamp is of what the sources held when it began.
  repo.write('bin/EDIT', join(repo.root, 'app/src/main/index.ts'))
  repo.write('app/src/renderer/ui/Thing.tsx', 'export const b = 4\n')
  expect(repo.start().built).toBe(true)
  rmSync(join(repo.root, 'bin/EDIT'))
  expect(repo.start().built).toBe(true)
  expect(repo.start().built).toBe(false)
})

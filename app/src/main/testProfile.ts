import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Under test (`TORNO_TEST=1`) Electron keeps nothing of its own under the person's home: its profile (cache,
// storage, crash dumps) is a folder of the run in the temporary folder. Without it every test launch wrote into
// `~/.config/torno`.

const PREFIX = 'torno-test-'
const NAMED = /^torno-test-(\d+)-/

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Makes the profile folder of this run, `<tmp>/torno-test-<pid>-<random>`, and clears away those of runs whose
 * process is gone (one that was killed removed nothing). Returns the folder.
 */
export function makeTestProfile(temp = tmpdir()): string {
  for (const name of readdirSync(temp)) {
    const pid = Number(NAMED.exec(name)?.[1])
    if (pid > 0 && pid !== process.pid && !alive(pid)) rmSync(join(temp, name), { recursive: true, force: true })
  }
  return mkdtempSync(join(temp, `${PREFIX}${process.pid}-`))
}

/**
 * Removes the profile once this process has gone: Chromium's own processes write there until they end, so a
 * removal made while quitting leaves what they write after it. A small shell waits for the process, and then
 * removes the folder; nothing is waited for here.
 */
export function removeTestProfileAfterExit(profile: string): void {
  if (!NAMED.test(profile.slice(profile.lastIndexOf('/') + 1))) return
  try {
    const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.1; done; sleep 0.3; rm -rf -- "$2"'
    spawn('sh', ['-c', script, 'sh', String(process.pid), profile], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    // The next test run clears it away (`makeTestProfile`).
  }
}

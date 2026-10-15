import { lstat, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { writeFileAtomic } from './atomic'

// Claude Code asks whether to trust a folder before it loads the hooks and the servers its settings name there. Run
// headless (`-p`, as the chat runs it) it does not ask: "The workspace trust dialog is skipped when Claude is run in
// non-interactive mode". So torno asks, before the first chat in a folder that has such settings, and remembers the
// answer in its own user data (`trusted.json`, beside the folders opened lately): never inside a workspace, and
// never in Claude Code's own settings. The terminal view has the CLI's own question.

/** What Claude Code loads from a folder, as paths below it. */
const PROJECT_FILES = ['.mcp.json', join('.claude', 'settings.json'), join('.claude', 'settings.local.json')]

const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false
  )

/**
 * The files Claude Code would load project settings from for an agent started in `dir`: `.mcp.json`,
 * `.claude/settings.json` and `.claude/settings.local.json` in `dir` and in each of its parents up to, not
 * including, `home` (a folder that is not under `home` goes up to the root). The person's own `~/.claude` is never
 * one of them. A link is reported by its own path and not followed: `.claude` being a link is reported as `.claude`.
 * Paths are relative to `dir`, the nearest first.
 */
export async function projectSettings(dir: string, home: string = homedir()): Promise<string[]> {
  const found: string[] = []
  for (let at = dir; at !== home; at = dirname(at)) {
    const claude = join(at, '.claude')
    const info = await lstat(claude).catch(() => null)
    for (const name of PROJECT_FILES) {
      const path = join(at, name)
      if (name.startsWith('.claude')) {
        // The folder itself being a link: what is behind it is not looked into.
        if (info?.isSymbolicLink()) {
          if (!found.includes(relative(dir, claude))) found.push(relative(dir, claude))
        } else if (info?.isDirectory() && (await exists(path))) found.push(relative(dir, path))
      } else if (await exists(path)) found.push(relative(dir, path))
    }
    if (dirname(at) === at) break
  }
  return found
}

/** The folders the person let the chat start in: the real paths. In `file` (written whole, atomically), or, with none, for this run only. */
export class Trust {
  private readonly memory = new Set<string>()

  constructor(
    private readonly file: string | null,
    private readonly home: string = homedir()
  ) {}

  private async trusted(): Promise<Set<string>> {
    const folders = new Set(this.memory)
    if (!this.file) return folders
    try {
      const body = JSON.parse(await readFile(this.file, 'utf8')) as { folders?: unknown }
      if (Array.isArray(body.folders)) for (const one of body.folders) if (typeof one === 'string') folders.add(one)
    } catch {
      // No file yet, or one that is not ours: nothing is trusted.
    }
    return folders
  }

  /** The project settings Claude Code would load from the folder, when the person has not yet said to start the chat there; none otherwise. */
  async pending(dir: string): Promise<string[]> {
    const files = await projectSettings(dir, this.home)
    if (files.length === 0) return []
    const real = await realpath(dir).catch(() => dir)
    return (await this.trusted()).has(real) ? [] : files
  }

  /** The person said to start the chat in this folder. */
  async accept(dir: string): Promise<void> {
    const real = await realpath(dir).catch(() => dir)
    this.memory.add(real)
    if (!this.file) return
    const folders = [...(await this.trusted())].sort()
    await writeFileAtomic(this.file, `${JSON.stringify({ folders }, null, 2)}\n`)
  }
}

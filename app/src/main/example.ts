import { existsSync } from 'node:fs'
import { cp, mkdtemp } from 'node:fs/promises'
import { basename, join } from 'node:path'

// The example the first screen offers: objects of the repository's own test workspace, which torno has
// beside it when it is run from the repository. It is never opened in place and never written to: what is
// opened is a copy in a temporary folder.

/** The objects of the test workspace that build and show something. The others are there to fail. */
export const EXAMPLE_OBJECTS = ['bracket', 'gauge', 'hollow', 'measures'] as const

/** Where the example is copied from, or null where there is none: a packaged app, or a repository without its fixtures. */
export function exampleSource(appPath: string, packaged: boolean): string | null {
  if (packaged) return null
  const source = join(appPath, '..', 'kernel', 'tests', 'fixtures', 'ws')
  return EXAMPLE_OBJECTS.every((name) => existsSync(join(source, name))) ? source : null
}

/** A copy of the example in a new folder under `tmp`, without what Python or torno left in the source. Answers with the copy's path. */
export async function copyExample(source: string, tmp: string): Promise<string> {
  const into = await mkdtemp(join(tmp, 'torno-example-'))
  for (const name of EXAMPLE_OBJECTS) {
    await cp(join(source, name), join(into, name), {
      recursive: true,
      filter: (from) => from === join(source, name) || (basename(from) !== '__pycache__' && !basename(from).startsWith('.'))
    })
  }
  return into
}

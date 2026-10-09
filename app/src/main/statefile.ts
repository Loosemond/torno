import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BuildState } from '../shared/build'
import type { Mark } from '../shared/marks'
import type { Scene } from '../shared/scene'
import type { ObjectInfo } from '../shared/workspace'
import { writeFileAtomic } from './atomic'
import { describeMark, sizes } from './marks/describe'

const FOLDER = '.torno'
const NAME = 'state.md'
const TRACEBACK_LINES = 12
/** How long after the last change of an object its file is written, in ms. */
export const STATE_DELAY_MS = 1000

/**
 * `<object>/.torno/state.md`: how the build stands, the layouts and their parts
 * with sizes, and every mark that is not resolved, a line each. It is what an
 * agent without torno's tools can read to know what one with them is told.
 * Nothing in it changes unless the build or the marks do: no times, no camera.
 */
export function stateText(obj: ObjectInfo, build: BuildState | undefined, last: { revision: number; scene: Scene } | undefined, marks: readonly Mark[]): string {
  const lines = [
    `# ${obj.name}`,
    '',
    'torno keeps this file: it is rewritten after every build and every change of the marks. Do not edit it.',
    'Lengths are millimetres, Z up, in the frame of the layout named.',
    '',
    '## Build',
    '',
    ...buildLines(build, last?.revision),
    '',
    '## Layouts and parts',
    ''
  ]
  if (!last) lines.push('Nothing has been built yet.')
  else {
    if (last.scene.model) lines.push(`Model: ${last.scene.model}, r${last.revision}.`, '')
    for (const layout of last.scene.layouts) {
      const parts = last.scene.parts.filter((p) => p.layout === layout)
      lines.push(`- ${layout}: ${parts.map((p) => `${p.name} ${sizes(p.bbox.max.map((max, i) => toHundredth(max - p.bbox.min[i])))} mm`).join(', ') || 'no parts'}`)
    }
  }
  lines.push('', '## Marks', '')
  const open = marks.filter((m) => m.status !== 'resolved')
  if (open.length === 0) lines.push('None.')
  else {
    lines.push(
      'What the user and the agent have pointed at and not resolved. `lid/F12` is face 12 of the part lid, `lid/E3` its edge 3, in the layout the mark is in.'
    )
    for (const layout of [...new Set(open.map((m) => m.layout))]) {
      lines.push('', `In layout ${layout}:`, '')
      for (const mark of open) if (mark.layout === layout) lines.push(`- ${describeMark(mark)}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/** To 0.01 mm, as the scene tool gives sizes: a bounding box comes from the mesh, which is that much off a round part. */
function toHundredth(value: number): number {
  return Math.round(value * 100) / 100
}

function buildLines(build: BuildState | undefined, revision = 0): string[] {
  const shown = revision > 0 ? `The parts below are those of r${revision}, the last build that worked.` : 'Nothing has been built yet.'
  if (!build || build.status === 'idle') return ['Not built yet.']
  if (build.status === 'building') return [`A build is running. ${shown}`]
  if (build.status === 'failed') {
    const traceback = (build.error?.traceback ?? '').trimEnd().split('\n').slice(-TRACEBACK_LINES).join('\n')
    return [`BUILD FAILED. ${shown}`, '', '```', build.error?.message ?? 'no reason was given', ...(traceback ? [traceback] : []), '```']
  }
  return [`Build ok, r${build.revision}.`]
}

export interface StateFileDeps {
  object(objectId: string): ObjectInfo | undefined
  /** Where the build of an object stands; undefined for one that is not open, of which nothing is written. */
  build(objectId: string): BuildState | undefined
  scene(objectId: string): { revision: number; scene: Scene } | undefined
  marks(objectId: string): Promise<Mark[]>
  delayMs?: number
  write?(path: string, text: string): Promise<void>
  log?(message: string): void
}

/**
 * Keeps the state file of every open object up to date. Told that an object's
 * build or marks changed, it waits until a second has passed without another
 * change and then writes the file, unless it already says the same.
 */
export class StateFiles {
  private timers = new Map<string, NodeJS.Timeout>()
  /** By path: what the file was last seen or made to hold. */
  private written = new Map<string, string>()

  constructor(private deps: StateFileDeps) {}

  /** The build or the marks of an object changed. */
  changed(objectId: string): void {
    clearTimeout(this.timers.get(objectId))
    const timer = setTimeout(() => {
      this.timers.delete(objectId)
      this.write(objectId).catch((e: unknown) => (this.deps.log ?? console.error)(`cannot write the state file of ${objectId}: ${e instanceof Error ? e.message : String(e)}`))
    }, this.deps.delayMs ?? STATE_DELAY_MS)
    // Nothing waits for a state file: it does not keep the app from quitting.
    timer.unref()
    this.timers.set(objectId, timer)
  }

  /** Drop what is waiting to be written, as when the workspace is left. */
  forget(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.written.clear()
  }

  /** Write the state file of an open object now, if it would say something new. */
  async write(objectId: string): Promise<void> {
    const obj = this.deps.object(objectId)
    if (!obj || !this.deps.build(objectId)) return
    const marks = await this.deps.marks(objectId)
    // As things are once the marks are read: a build may have ended meanwhile.
    const build = this.deps.build(objectId)
    if (!build || this.deps.object(objectId)?.dir !== obj.dir) return
    const text = stateText(obj, build, this.deps.scene(objectId), marks)
    const path = join(obj.dir, FOLDER, NAME)
    if (!this.written.has(path)) {
      // The file of an earlier run, which may already say this.
      const onDisk = await readFile(path, 'utf8').catch(() => null)
      if (onDisk !== null) this.written.set(path, onDisk)
    }
    if (this.written.get(path) === text) return
    await (this.deps.write ?? writeFileAtomic)(path, text)
    this.written.set(path, text)
  }
}

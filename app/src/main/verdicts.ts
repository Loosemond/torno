import { verdictOn } from '../shared/dimension'
import type { DimensionMark, Mark } from '../shared/marks'
import type { Verdict, VerdictChange } from '../shared/sanity'

/** How many builds of an object have their verdicts kept: those before are forgotten. */
export const VERDICTS_KEPT = 16

/** The verdicts of one build: by mark id, of each unresolved dimension with an expected value. */
export type BuildVerdicts = ReadonlyMap<string, Verdict>

/**
 * Each successful build's verdicts on the dimensions, in main's memory alone: by object, a snapshot per revision of
 * what every unresolved dimension with an expected value says of that build (`pass`, `fail`, or `none` while it has
 * no value of it). Main records it whenever the marks of an object change and when a check of them against a build
 * ends (`index.ts`), always of the last successful build: a mark keeps one value, and once it is measured on a newer
 * build what it said of an older one is only here. A revision's snapshot is replaced while that revision is the
 * last, and never after.
 *
 * `verdictChanges` is the one place that says which dimensions changed verdict between two builds: the digest of a
 * build (`sanity.ts`), the Stop hook and the chat's build line take it from there.
 */
export class Verdicts {
  private kept = new Map<string, Map<number, Map<string, Verdict>>>()
  /** By object, the revision whose marks were last checked against its build to the end. */
  private checked = new Map<string, number>()
  private waiters = new Set<() => void>()

  /** What the marks of an object say of build `revision`, the last successful one: its snapshot from now on. */
  record(objectId: string, revision: number | undefined, marks: readonly Mark[]): void {
    if (revision === undefined || revision <= 0) return
    const builds = this.kept.get(objectId) ?? new Map<number, Map<string, Verdict>>()
    // An older build's verdicts are no longer what the marks say: the marks hold the newer build's values.
    if ([...builds.keys()].some((kept) => kept > revision)) return
    const snapshot = new Map<string, Verdict>()
    for (const mark of marks) {
      if (mark.kind !== 'dimension' || mark.status === 'resolved' || (mark as DimensionMark).expected === undefined) continue
      snapshot.set(mark.id, verdictOn(mark as DimensionMark, revision) ?? 'none')
    }
    builds.set(revision, snapshot)
    for (const old of [...builds.keys()].sort((a, b) => a - b).slice(0, Math.max(0, builds.size - VERDICTS_KEPT))) builds.delete(old)
    this.kept.set(objectId, builds)
  }

  /**
   * The marks of an object were checked against build `revision`, and its dimensions measured on it, as far as they
   * could be: `record` with them (none when they could not be read), and wake whoever waits for that build.
   */
  checkedOn(objectId: string, revision: number | undefined, marks?: readonly Mark[]): void {
    if (revision === undefined) return
    if (marks) this.record(objectId, revision, marks)
    this.checked.set(objectId, Math.max(revision, this.checked.get(objectId) ?? 0))
    const waiting = this.waiters
    this.waiters = new Set()
    for (const wake of waiting) wake()
  }

  /** The verdicts of build `revision` of an object, as last recorded; undefined of one never recorded or forgotten. */
  of(objectId: string, revision: number | undefined): BuildVerdicts | undefined {
    return revision === undefined ? undefined : this.kept.get(objectId)?.get(revision)
  }

  /**
   * Resolves once the marks of an object have been checked against build `revision` (or a later one), or at `until`
   * (ms epoch), whichever comes first: the answer to an edit waits so that its dimensions are of its build.
   */
  settled(objectId: string, revision: number, until: number): Promise<void> {
    return new Promise((done) => {
      const look = (): void => {
        if ((this.checked.get(objectId) ?? 0) >= revision || Date.now() >= until) {
          clearTimeout(timer)
          this.waiters.delete(look)
          done()
        } else this.waiters.add(look)
      }
      const timer = setTimeout(() => {
        this.waiters.delete(look)
        done()
      }, Math.max(0, until - Date.now()))
      look()
    })
  }

  /** Forget an object's verdicts, or every object's, as when its workspace is left. */
  forget(objectId?: string): void {
    if (objectId === undefined) {
      this.kept.clear()
      this.checked.clear()
    } else {
      this.kept.delete(objectId)
      this.checked.delete(objectId)
    }
  }
}

/**
 * The dimensions whose verdict on one build (`now`) is another than on an earlier one (`was`), in the order of
 * `now`: one that was not there before is `none` then. A dimension `now` does not hold (resolved since, or gone) is
 * not told. Nothing of builds whose verdicts are not both known: `[]`.
 */
export function verdictChanges(was: BuildVerdicts | undefined, now: BuildVerdicts | undefined): VerdictChange[] {
  if (!was || !now) return []
  const changes: VerdictChange[] = []
  for (const [id, verdict] of now) {
    const before = was.get(id) ?? 'none'
    if (before !== verdict) changes.push({ id, was: before, now: verdict })
  }
  return changes
}

// What the kernel says of a ref, in one line, kept for as long as the revision
// it was said of is on screen: the readout at the pointer and the selection ask
// for the same refs again and again.

import type { Described } from '../../shared/geometry'

let scope = ''
const known = new Map<string, string>()
const asked = new Map<string, Promise<Described | null>>()

function enter(objectId: string, revision: number): void {
  const now = `${objectId}\n${revision}`
  if (now === scope) return
  scope = now
  known.clear()
  asked.clear()
}

/** The descriptor of a ref, if the kernel has already given it for this revision. */
export function descriptorOf(objectId: string, revision: number, layout: string, ref: string): string | undefined {
  enter(objectId, revision)
  return known.get(`${layout}\n${ref}`)
}

/**
 * Asks the kernel for the descriptor of a ref, once per revision. Null when it
 * could not say (the ref names nothing, the build is gone): the next call asks again.
 */
export function describe(objectId: string, revision: number, layout: string, ref: string): Promise<string | null> {
  return describeWhole(objectId, revision, layout, ref).then((described) => described?.descriptor ?? null)
}

/** The same, with everything the kernel says of the ref: where its middle is, as well as its line. */
export function describeWhole(objectId: string, revision: number, layout: string, ref: string): Promise<Described | null> {
  enter(objectId, revision)
  const key = `${layout}\n${ref}`
  const pending = asked.get(key)
  if (pending) return pending
  const mine = scope
  const answer = window.torno.geometry.describe(objectId, layout, ref).then(
    (described) => {
      if (scope === mine) known.set(key, described.descriptor)
      return described
    },
    () => {
      if (scope === mine) asked.delete(key)
      return null
    }
  )
  asked.set(key, answer)
  return answer
}

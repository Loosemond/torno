/**
 * What a successful build did to the parts, as main works it out from what the kernel sent with it and with the
 * successful build before (`main/sanity.ts` `sanity`): the digest the agent is told with the build of its edit, and
 * the data the window draws it from. Nothing in it is guessed at: every number is the kernel's, and says whether it
 * is exact.
 */

/** A dimension's verdict on one build: `none` when it has no value of that build (not measured, not measurable). */
export type Verdict = 'pass' | 'fail' | 'none'

/** A dimension whose verdict is another on one build than on an earlier one (`main/verdicts.ts` `verdictChanges`). */
export interface VerdictChange {
  id: string
  was: Verdict
  now: Verdict
}

/** What can be wrong with a part, as the shape alone says it, or what an edit did that the agent must know of. */
export type FlagKind =
  /** OCC's check of the shape finds a defect (`Part.valid` false). */
  | 'invalid'
  /** A solid of it is turned inside out (`Part.reversed`). */
  | 'reversed'
  /** It has no solid, or no volume. */
  | 'empty'
  /** It is of more than one solid, or of another number of them than before. */
  | 'solids'
  /** A shell of it has an edge only one face has (`Part.openShells`). */
  | 'open'
  /** What its own mesh encloses is not its volume (`Part.meshDisagrees`). */
  | 'mesh'
  | 'added'
  | 'removed'
  /** Its faces or edges are of another number than before: its refs may name others now. */
  | 'refs'
  /** A dimension that passed on the build before and fails on this one. */
  | 'dimension'

export interface DigestFlag {
  kind: FlagKind
  /** The part it is of; absent of a dimension's. */
  part?: string
  /** The dimension's mark, of a `dimension` flag. */
  mark?: string
  /** Whether the build compared with did not have it: of a first build, every one. */
  new: boolean
  /**
   * A defect that appeared with this build and that a sound part never has: not valid, inside out, more solids
   * than before, a mesh that disagrees with its volume. A change of volume alone is none.
   */
  hard: boolean
  /** What the digest says of it. */
  text: string
}

/** One number of a part on both builds, and whether both builds say it is exact. */
export interface Compared<T> {
  before: T
  after: T
  exact: boolean
}

/** A part that changed since the build compared with, with its line, as `diff` says it. */
export interface DigestPart {
  name: string
  /** The layout it was compared in: the first of the build that has it. */
  layout: string
  /** `tub: volume 28400 → 26100 mm³ (-2300, -8.1 %), faces 14 → 22` */
  text: string
  volume: Compared<number> & { change: number; percent?: number }
  size: Compared<[number, number, number]>
  faces: { before: number; after: number }
  edges: { before: number; after: number }
  solids?: { before?: number; after?: number }
}

export interface BuildDigest {
  /** The build it is of. */
  revision: number
  /** The successful build it was compared with; absent for the first. */
  since?: number
  /** Whether any part's volume, box, face, edge or solid count changed, or a part came or went. False of a first build. */
  changed: boolean
  /** The parts that changed, in the order of the build. */
  parts: DigestPart[]
  /** How many parts are as they were. */
  unchanged: number
  /** What the shape says and what the edit did, the hard defects first. */
  flags: DigestFlag[]
  /** The dimensions whose verdict on this build is another than on `since`, as far as both were measured. */
  dimensions: VerdictChange[]
}

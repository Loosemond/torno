import type { SessionStatus } from './bridge'

/**
 * What the page of objects says of one object of the workspace. Everything here is read: from what main already
 * knows of an object opened in this run, and from the files under its `.torno/` otherwise. Nothing is built,
 * started or loaded to say it.
 */
export interface ObjectCard {
  id: string
  name: string
  /** Why it cannot be built, as the object list says it. */
  problem?: string
  /** The same with the folder's whole path, where `problem` names it by its name alone: for a tooltip. */
  problemAt?: string
  /** Opened in this run: it has a build state, and its marks are checked against it. */
  opened: boolean
  build?: { status: 'idle' | 'building' | 'ok' | 'failed'; revision: number; stale: boolean; letGo?: 'memory'; error?: string }
  /**
   * The picture on file: when it was made, of which layout, and whether the model file is newer than it (or
   * another). What it draws otherwise than the object is: `cut` by the section kept with the view, the parts
   * `apart`, and how many parts of the layout it leaves out (`hidden`). Null for none.
   */
  thumb: { at: string; layout: string; behind: boolean; cut?: true; apart?: true; hidden?: number } | null
  /** When the newest source of its model was saved (ms since the epoch), read from the files; absent when it has none. */
  sourcesMtimeMs?: number
  /** Null when the marks file could not be read. */
  marks: { open: number; drafts: number } | null
  /** Of the last build of this run; null for an object not built in it (a verdict of no build of this run is none). */
  dimensions: { failing: number; unmeasured: number; passing: number } | null
  /**
   * Only with `dimensions: null`, and only when the object has open dimensions: how many, and how many of them
   * failed when they were last measured, in a run before. No verdict: of no build of this run.
   */
  lastRun?: { dimensions: number; failed: number }
  /** Where its session stands. */
  session: SessionStatus | null
}

/** What a picture is of besides its layout, as the window says it of one it drew. */
export interface ThumbnailOf {
  layout: string
  /** How many parts it draws. */
  parts: number
  cut?: boolean
  apart?: boolean
  /** How many parts of the layout it leaves out. */
  hidden?: number
}

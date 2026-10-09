// A key a tool does not take is never dropped in silence. A slip in a key's name ("ignored" for "ignore", "scans"
// for "scan") would otherwise change what is measured with no word of it: the region the agent meant to leave out
// is counted, a point of a scan is taken for a bare point. Whoever takes an object from the agent asks here first.

/** How many letters must be put in, taken out or changed to make one word of another. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]
}

/** The key among `accepted` that `key` most likely stands for: within two letters of it and less than half its length, whatever the case; null when none is that near. */
export function nearestKey(key: string, accepted: readonly string[]): string | null {
  let best: string | null = null
  let least = Infinity
  for (const one of accepted) {
    const off = distance(key.toLowerCase(), one.toLowerCase())
    if (off < least && off <= 2 && off < Math.max(key.length, one.length) / 2) [best, least] = [one, off]
  }
  return best
}

/**
 * Why an object holds keys that are none of those taken, as the agent is told, or null when it holds none such:
 * each unknown key by name with the nearest key that is taken, that nothing was done, and what is taken. `what`
 * is who takes it: a tool (`scan_clash`), or a value of one (`the end a`). Null for what is no object.
 */
export function unknownKeys(given: unknown, accepted: readonly string[], what: string): string | null {
  if (typeof given !== 'object' || given === null || Array.isArray(given)) return null
  const unknown = Object.keys(given).filter((key) => !accepted.includes(key))
  if (unknown.length === 0) return null
  const meant = unknown.map((key) => nearestKey(key, accepted))
  const said = unknown.length === 1 ? `"${unknown[0]}"${meant[0] ? `: did you mean ${meant[0]}?` : '.'}` : `${unknown.map((key, i) => `"${key}"${meant[i] ? ` (did you mean ${meant[i]}?)` : ''}`).join(', ')}.`
  return `${what} takes no ${said} An unknown key is not ignored: nothing was done. It takes${accepted.length > 0 ? `: ${accepted.join(', ')}` : ' no arguments'}.`
}

/** An object without the keys that are none of those taken; anything else as it is. */
export function withoutUnknown(given: unknown, accepted: readonly string[]): unknown {
  if (typeof given !== 'object' || given === null || Array.isArray(given)) return given
  return Object.fromEntries(Object.entries(given).filter(([key]) => accepted.includes(key)))
}

/**
 * Whether the unknown keys of a value are what is wrong with it: it would be what was asked for without them
 * (`{axis, at, offset}` is a plane with a key too many), or one of them is a slip of a key that is taken (`att`).
 * Otherwise the value is something else altogether (`{z: 3}`), and whoever reads it says what one looks like.
 */
export function onlyKeysWrong(given: unknown, accepted: readonly string[], isOne: (value: unknown) => boolean): boolean {
  if (typeof given !== 'object' || given === null || Array.isArray(given)) return false
  const unknown = Object.keys(given).filter((key) => !accepted.includes(key))
  return unknown.length > 0 && (isOne(withoutUnknown(given, accepted)) || unknown.some((key) => nearestKey(key, accepted) !== null))
}

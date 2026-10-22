/**
 * What the title of a folded section says beside its name: what matters of what it holds, numbers first. The
 * window sets the numbers in the monospace face (`numbered`).
 */

/** `12 · 3 hidden`: the parts of the layout shown, and those switched off. */
export function layersSaid(parts: number, hidden: number): string {
  return hidden > 0 ? `${parts} · ${hidden} hidden` : `${parts}`
}

/** The words of a scan's state that ask for something: not aligned here, to be checked, rough, its mesh gone. */
const TO_SEE = new Set(['unaligned', 'check', 'rough', 'missing'])

/**
 * `1 · unaligned`, `4 · 2 unaligned · 1 check`: the scans, and each word of their states (`scanState`) that asks
 * for something, in the order the scans have them. One scan alone has its word without a count.
 */
export function scansSaid(words: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const word of words) if (TO_SEE.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1)
  const said = [...counts].map(([word, n]) => (words.length === 1 ? word : `${n} ${word}`))
  return [`${words.length}`, ...said].join(' · ')
}

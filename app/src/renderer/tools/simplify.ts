/**
 * A drawn line with fewer points: first those that say nothing are dropped
 * (Ramer–Douglas–Peucker: a point nearer than `tolerance` to the line between
 * the ones kept on either side of it), then, if more than `max` are left,
 * points are taken evenly along the line until `max` are. The ends are always
 * kept. For points of two or three numbers, in whatever unit `tolerance` is in.
 */
export function simplify<P extends number[]>(points: P[], tolerance: number, max: number): P[] {
  if (points.length <= 2) return points.slice(0, Math.max(max, 0))
  const keep = new Uint8Array(points.length)
  keep[0] = keep[points.length - 1] = 1
  // Spans still to look at, as pairs of indices: no recursion, a stroke may be thousands of points long.
  const spans: number[] = [0, points.length - 1]
  while (spans.length > 0) {
    const last = spans.pop()!
    const first = spans.pop()!
    let far = -1
    let most = tolerance
    for (let i = first + 1; i < last; i++) {
      const d = offLine(points[i], points[first], points[last])
      if (d > most) {
        most = d
        far = i
      }
    }
    if (far < 0) continue
    keep[far] = 1
    spans.push(first, far, far, last)
  }
  const kept = points.filter((_, i) => keep[i] === 1)
  return thin(kept, max)
}

/** At most `max` of the points, taken evenly, the first and the last among them. */
function thin<P>(points: P[], max: number): P[] {
  if (points.length <= max) return points
  if (max < 2) return points.slice(0, Math.max(max, 0))
  const step = (points.length - 1) / (max - 1)
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)])
}

/** How far a point is from the segment between two others. */
function offLine(p: number[], a: number[], b: number[]): number {
  let along = 0
  let length = 0
  for (let k = 0; k < p.length; k++) {
    const ab = b[k] - a[k]
    along += (p[k] - a[k]) * ab
    length += ab * ab
  }
  const t = length > 0 ? Math.min(Math.max(along / length, 0), 1) : 0
  let off = 0
  for (let k = 0; k < p.length; k++) {
    const d = p[k] - (a[k] + (b[k] - a[k]) * t)
    off += d * d
  }
  return Math.sqrt(off)
}

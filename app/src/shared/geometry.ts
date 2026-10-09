/**
 * What the kernel says of a part, a face or an edge: its `describe` reply, with
 * the one line that sums it up. The other fields depend on the kind.
 */
export interface Described {
  kind: 'part' | 'face' | 'edge'
  ref: string
  descriptor: string       // "plane, normal +Z, z = 20, 1180 mm²"
  [field: string]: unknown
}

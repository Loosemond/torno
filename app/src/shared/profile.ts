import { number } from './format'

// The printer and the material a project is made for. They are the person's numbers, not the kernel's: a verdict
// against them says so, and is never a claim that the part prints. The person's own are kept in torno's settings
// (`profiles.json` beside `config.json`); a project names the one it is for in `<project>/.torno/profile.json`, with
// the values copied, so the project travels with what it was checked against.

export const FITS = ['press', 'sliding', 'loose'] as const
export type Fit = (typeof FITS)[number]

/** A clearance band, per side: the least and the most gap, in mm, that makes the fit. */
export type Band = [number, number]

export interface Printer {
  name: string
  /** The build volume, [x, y, z] mm. */
  bed: [number, number, number]
  /** The nozzle, mm. */
  nozzle: number
  /** The layer height, mm. */
  layer?: number
}

export interface Material {
  name: string
  /** g/cm³. */
  density: number
  /** The shrink, per cent. Told, never applied. */
  shrink?: number
  /** The gap per side of each fit, mm. */
  fits: Record<Fit, Band>
  /** The least wall, mm. Without it, two nozzle widths. */
  minWall?: number
  /** Degrees from vertical a face may lean before it needs support. */
  overhang?: number
}

/** What a project is made for: either may be missing. */
export interface Profile {
  printer?: Printer
  material?: Material
}

/** The settings file: the person's printers and materials. */
export interface Profiles {
  printers: Printer[]
  materials: Material[]
}

/** Typical values to start from, not measurements: the person adds their own. */
export const STARTER_MATERIALS: Material[] = [
  { name: 'PLA', density: 1.24, shrink: 0.3, fits: { press: [0, 0.1], sliding: [0.2, 0.3], loose: [0.4, 0.5] }, minWall: 0.8, overhang: 45 },
  { name: 'PETG', density: 1.27, shrink: 0.4, fits: { press: [0.05, 0.15], sliding: [0.3, 0.4], loose: [0.5, 0.6] }, minWall: 0.8, overhang: 45 },
  { name: 'ABS', density: 1.04, shrink: 0.6, fits: { press: [0.05, 0.15], sliding: [0.3, 0.4], loose: [0.5, 0.6] }, minWall: 0.8, overhang: 40 }
]

const MAX_NAME = 60
const positive = (v: unknown, most: number): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= most
const nameOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' && v.length <= MAX_NAME && !/[\u0000-\u001f\u007f-\u009f]/.test(v) ? v.trim() : null)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A printer out of whatever was given; null when it is not one. */
export function printerOf(value: unknown): Printer | null {
  if (!isRecord(value)) return null
  const name = nameOf(value.name)
  const bed = value.bed
  if (!name || !Array.isArray(bed) || bed.length !== 3 || !bed.every((x) => positive(x, 5000)) || !positive(value.nozzle, 5)) return null
  return { name, bed: [bed[0], bed[1], bed[2]], nozzle: value.nozzle, ...(positive(value.layer, 5) ? { layer: value.layer } : {}) }
}

function bandOf(value: unknown): Band | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const [low, high] = value
  return typeof low === 'number' && typeof high === 'number' && Number.isFinite(low) && Number.isFinite(high) && low >= 0 && high >= low && high <= 5 ? [low, high] : null
}

/** A material out of whatever was given; null when it is not one. A fit it does not say is left to the PLA values. */
export function materialOf(value: unknown): Material | null {
  if (!isRecord(value)) return null
  const name = nameOf(value.name)
  if (!name || !positive(value.density, 30)) return null
  const given = isRecord(value.fits) ? value.fits : {}
  const base = STARTER_MATERIALS[0].fits
  const fits = Object.fromEntries(FITS.map((fit) => [fit, bandOf(given[fit]) ?? base[fit]])) as Record<Fit, Band>
  return {
    name,
    density: value.density,
    ...(positive(value.shrink, 20) ? { shrink: value.shrink } : {}),
    fits,
    ...(positive(value.minWall, 20) ? { minWall: value.minWall } : {}),
    ...(positive(value.overhang, 89.9) ? { overhang: value.overhang } : {})
  }
}

/** A profile out of what a file holds: what is not a printer or a material is left out. */
export function profileOf(value: unknown): Profile {
  const file = isRecord(value) ? value : {}
  const printer = printerOf(file.printer)
  const material = materialOf(file.material)
  return { ...(printer ? { printer } : {}), ...(material ? { material } : {}) }
}

/** The person's settings out of what the file holds. */
export function profilesOf(value: unknown): Profiles {
  const file = isRecord(value) ? value : {}
  const keep = <T extends { name: string }>(raw: unknown, make: (v: unknown) => T | null): T[] => {
    const out: T[] = []
    for (const one of Array.isArray(raw) ? raw : []) {
      const made = make(one)
      if (made && !out.some((o) => o.name.toLowerCase() === made.name.toLowerCase())) out.push(made)
    }
    return out
  }
  return { printers: keep(file.printers, printerOf), materials: keep(file.materials, materialOf) }
}

export const isEmpty = (p: Profile | undefined): boolean => !p || (!p.printer && !p.material)

/** "Bambu X1C, PETG": what a reading says its numbers are by. */
export function profileName(p: Profile): string {
  return [p.printer?.name, p.material?.name].filter(Boolean).join(', ')
}

/** The least wall to ask for: the material's, else two nozzle widths. */
export function leastWall(p: Profile | undefined): number | undefined {
  return p?.material?.minWall ?? (p?.printer ? 2 * p.printer.nozzle : undefined)
}

export interface FitVerdict {
  verdict: 'within' | 'tighter' | 'looser'
  /** How far outside the band, mm; 0 within. */
  by: number
}

/** Where a gap (mm, per side) stands against the band of a fit. */
export function fitVerdict(distance: number, band: Band): FitVerdict {
  const by = (x: number): number => Math.round(x * 1e6) / 1e6
  if (distance < band[0]) return { verdict: 'tighter', by: by(band[0] - distance) }
  if (distance > band[1]) return { verdict: 'looser', by: by(distance - band[1]) }
  return { verdict: 'within', by: 0 }
}

const bandText = (b: Band): string => `${number(b[0])} to ${number(b[1])}`

/**
 * The line a new conversation is told, and state.md holds: whose the numbers are (the person's), what they are, and
 * which tools take them. Empty when there is no profile.
 */
export function profileLine(p: Profile | undefined): string {
  if (!p || isEmpty(p)) return ''
  const parts: string[] = []
  const { printer, material } = p
  if (printer) parts.push(`printer ${printer.name}, bed ${printer.bed.map(number).join(' × ')} mm, nozzle ${number(printer.nozzle)} mm${printer.layer ? `, layer ${number(printer.layer)} mm` : ''}`)
  if (material) {
    const wall = leastWall(p)
    parts.push(
      `material ${material.name}, ${number(material.density)} g/cm³${material.shrink ? `, shrink ${number(material.shrink)} %` : ''}, gap per side: ${FITS.map((f) => `${f} ${bandText(material.fits[f])}`).join(', ')} mm${wall ? `, least wall ${number(wall)} mm` : ''}${material.overhang ? `, overhang ${number(material.overhang)}°` : ''}`
    )
  }
  return `Print profile of this project (the person's numbers, not measured): ${parts.join('; ')}. check bed, thin, overhang and clearance (fit) and measure mass use it when you leave their values out; take clearances from it for the model's Params, not from memory.`
}

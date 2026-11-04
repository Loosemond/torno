import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'
import { FOLDER, writeOwn } from './own'
import { type Material, type Printer, type Profile, type Profiles, STARTER_MATERIALS, isEmpty, materialOf, printerOf, profileOf, profilesOf } from '../shared/profile'

// Printers and materials are the person's, kept in torno's own user data (`profiles.json`, beside `config.json`), never
// in a workspace. A project names the one it is made for in `<project>/.torno/profile.json`, with the values copied, so
// that it travels with what it was checked against. Main reads that file at each question (it is small), so what the
// tools and the context say is always what the file says.

const NAME = 'profile.json'

/** The profile of the project in `dir`; undefined when it has none or the file is not one of ours. */
export function projectProfile(dir: string): Profile | undefined {
  try {
    const profile = profileOf(JSON.parse(readFileSync(join(dir, FOLDER, NAME), 'utf8')))
    return isEmpty(profile) ? undefined : profile
  } catch {
    return undefined
  }
}

/** Names the printer and the material a project is made for (copied), or, with none, takes them off. */
export function setProjectProfile(dir: string, profile: Profile): Promise<Profile | undefined> {
  const kept = profileOf(profile)
  return writeOwn(dir, NAME, `${JSON.stringify(kept, null, 2)}\n`).then(() => (isEmpty(kept) ? undefined : kept))
}

/** The person's printers and materials, in `file` (written whole, atomically), or, with none, for this run alone. */
export class UserProfiles {
  private memory: Profiles | null = null

  constructor(private readonly file: string | null) {}

  private async read(): Promise<Profiles> {
    if (this.memory) return this.memory
    let kept: Profiles = { printers: [], materials: [] }
    if (this.file) {
      try {
        kept = profilesOf(JSON.parse(await readFile(this.file, 'utf8')))
      } catch {
        // No file yet, or one that is not ours.
      }
    }
    return (this.memory = kept)
  }

  /** What to choose from: their printers, and their materials after the starter ones (one of theirs of the same name replaces it). */
  async list(): Promise<Profiles> {
    const mine = await this.read()
    const names = new Set(mine.materials.map((m) => m.name.toLowerCase()))
    return { printers: [...mine.printers], materials: [...mine.materials, ...STARTER_MATERIALS.filter((m) => !names.has(m.name.toLowerCase()))] }
  }

  private async keep(next: Profiles): Promise<Profiles> {
    this.memory = next
    if (this.file) await writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`)
    return this.list()
  }

  /** Adds a printer, or replaces the one of that name. Rejects with why when it is not a printer. */
  async savePrinter(value: unknown): Promise<Profiles> {
    const printer: Printer | null = printerOf(value)
    if (!printer) throw new Error('a printer has a name, a bed of three sizes in mm and a nozzle in mm')
    const mine = await this.read()
    return this.keep({ ...mine, printers: [...mine.printers.filter((p) => p.name.toLowerCase() !== printer.name.toLowerCase()), printer] })
  }

  async saveMaterial(value: unknown): Promise<Profiles> {
    const material: Material | null = materialOf(value)
    if (!material) throw new Error('a material has a name and a density in g/cm³')
    const mine = await this.read()
    return this.keep({ ...mine, materials: [...mine.materials.filter((m) => m.name.toLowerCase() !== material.name.toLowerCase()), material] })
  }

  async removePrinter(name: string): Promise<Profiles> {
    const mine = await this.read()
    return this.keep({ ...mine, printers: mine.printers.filter((p) => p.name !== name) })
  }
}

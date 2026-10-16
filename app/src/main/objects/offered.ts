/** The most paths remembered: a person chooses a few photos at a time. */
const MOST = 500

/**
 * The files main's own photo dialog (or its test hook) handed the window. The window cannot read a file, so it asks
 * main for the bytes of one of these (`objects.readPhoto`): never of a path it names on its own.
 */
export class Offered {
  private paths = new Set<string>()

  add(paths: readonly string[]): void {
    for (const path of paths) {
      if (this.paths.size >= MOST) this.paths.delete(this.paths.values().next().value as string)
      this.paths.add(path)
    }
  }

  has(path: unknown): boolean {
    return typeof path === 'string' && this.paths.has(path)
  }

  clear(): void {
    this.paths.clear()
  }
}

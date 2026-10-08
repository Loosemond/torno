import { join } from 'node:path'
import { app } from 'electron'

/**
 * The kernel's Python project (the folder with its pyproject.toml). In
 * development that is the repository's `kernel/`, beside `app/`; a packaged app
 * carries a copy in its resources.
 */
export function kernelDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'kernel') : join(app.getAppPath(), '..', 'kernel')
}

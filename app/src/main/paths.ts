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

/**
 * torno's plugin of skills for Claude Code (`--plugin-dir`), read by the CLI as it is: `app/resources/agent-plugin`
 * in development and in a build run from the repository (`app.getAppPath()` is `app/` in both); a packaged app
 * carries a copy in its resources, as it does the kernel.
 */
export function agentPluginDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'agent-plugin') : join(app.getAppPath(), 'resources', 'agent-plugin')
}

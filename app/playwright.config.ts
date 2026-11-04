import { defineConfig } from '@playwright/test'

// The e2e tests launch the built Electron app (out/), always with TORNO_TEST=1
// so no window is ever shown. One worker: the tests share one GPU and display.
// And no kernel the app starts under test lets a build go for want of memory: the specs pass their environment on.
process.env.TORNO_KEEP_BUILDS = '1'

export default defineConfig({
  testDir: './e2e',
  // The evals run the real Claude Code: never a test (`src/evals.test.ts`).
  testIgnore: ['**/evals/**'],
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  outputDir: './e2e/.results'
})

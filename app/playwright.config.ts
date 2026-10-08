import { defineConfig } from '@playwright/test'

// The e2e tests launch the built Electron app (out/), always with TORNO_TEST=1
// so no window is ever shown. One worker: the tests share one GPU and display.
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  outputDir: './e2e/.results'
})

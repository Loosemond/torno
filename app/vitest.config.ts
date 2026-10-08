import { defineConfig } from 'vitest/config'

// `pnpm test` runs the fast unit tests (*.test.ts).
// `pnpm test:kernel` (mode "kernel") runs *.itest.ts, which need the Python kernel.
export default defineConfig(({ mode }) => ({
  test: {
    environment: 'node',
    include: mode === 'kernel' ? ['src/**/*.itest.ts'] : ['src/**/*.test.ts'],
    testTimeout: mode === 'kernel' ? 120_000 : 5_000
  }
}))

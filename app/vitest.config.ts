import { defineConfig } from 'vitest/config'

// `pnpm test` runs the fast unit tests (*.test.ts).
// `pnpm test:kernel` (mode "kernel") runs *.itest.ts, which need the Python kernel.
export default defineConfig(({ mode }) => ({
  test: {
    environment: 'node',
    // No kernel a test starts lets a build go for want of memory (`Supervisor._make_room`): what a test sees must not
    // depend on how much the machine has free. Nothing but the suites sets it.
    env: { TORNO_KEEP_BUILDS: '1' },
    include: mode === 'kernel' ? ['src/**/*.itest.ts'] : ['src/**/*.test.ts'],
    testTimeout: mode === 'kernel' ? 120_000 : 5_000
  }
}))

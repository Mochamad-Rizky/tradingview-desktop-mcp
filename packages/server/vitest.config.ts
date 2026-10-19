import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // The bin entry only hands the process to runCli, which the tests run in process. The tests
      // that start the built CLI do so in child processes, which coverage does not see.
      exclude: ['src/cli.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.e2e.test.ts'],
          testTimeout: 120_000,
          // The snapshot and the restore around a suite switch symbols and wait for their data.
          hookTimeout: 120_000,
          // E2E tests drive one real TradingView window, so files must never overlap.
          fileParallelism: false,
        },
      },
    ],
  },
});

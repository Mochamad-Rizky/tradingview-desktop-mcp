import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      // Tests that type and pick from menus through user-event, or render hundreds of rows, take a
      // few seconds under coverage, and the root scripts run them next to the server's suite: the 5 s
      // default leaves too little room on a busy machine.
      testTimeout: 15_000,
      restoreMocks: true,
      coverage: {
        provider: 'v8',
        include: ['src/**'],
        // The shadcn components are vendored as the CLI wrote them. main.tsx only mounts the app,
        // which the tests render themselves.
        exclude: ['src/components/ui/**', 'src/main.tsx', 'src/test/**', 'src/**/*.test.{ts,tsx}'],
        reporter: ['text', 'lcov', 'json-summary'],
        thresholds: {
          lines: 80,
          branches: 80,
          functions: 80,
          statements: 80,
        },
      },
    },
  }),
);

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

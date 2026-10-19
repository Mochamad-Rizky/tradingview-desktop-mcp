import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  // The bin entry is run, never imported, so only the library entry gets type declarations.
  dts: { entry: ['src/index.ts'] },
  clean: true,
});

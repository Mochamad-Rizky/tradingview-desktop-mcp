import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/', '**/coverage/', '.superpowers/']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // The project service picks the nearest tsconfig.json per file, so every package keeps
        // its own compiler options and no per-package lint config is needed.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Tooling configs are plain JavaScript outside any tsconfig, so type-aware rules cannot run.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // The scripts at the repository root are plain Node programs outside any package, so ESLint has
    // to be told that process, console and the timers exist there.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    rules: {
      // Stdout carries JSON-RPC in stdio mode, so a stray console call would corrupt the protocol.
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);

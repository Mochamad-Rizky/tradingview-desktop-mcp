import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
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
    // The plain JavaScript scripts, at the repository root and in a package, are Node programs
    // outside any tsconfig, so ESLint has to be told that process, console and the timers exist.
    files: ['scripts/**/*.mjs', 'packages/*/scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // The dashboard runs in the browser, and its components follow the rules of hooks.
    files: ['packages/dashboard/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    // The dashboard imports the API contract from the server's source with `@contract`, an alias
    // the type checker knows and the bundler does not: it must only ever bring types. With
    // verbatimModuleSyntax an import kept for its inline `type` names alone stays in the output as
    // a bare import, so a type-only import must say so as a whole. The vendored components are
    // left as the shadcn CLI wrote them.
    files: ['packages/dashboard/**/*.{ts,tsx}'],
    ignores: ['packages/dashboard/src/components/ui/**'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    rules: {
      // Stdout carries JSON-RPC in stdio mode, so a stray console call would corrupt the protocol.
      // The dashboard keeps the rule too: what it has to say belongs on the page.
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);

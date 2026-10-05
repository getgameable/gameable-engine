import tsParser from '@typescript-eslint/parser';

/**
 * End-to-end specs are TypeScript, and the root flat config only wires the
 * TypeScript parser for `packages/`, `templates/` and `examples/`. ESLint 10
 * resolves a config from the linted file's own directory upwards, so this file
 * governs `tests/e2e/**` and nothing else.
 *
 * Deliberately plain: it does not call `tseslint.config()`, because that
 * registers a second candidate `tsconfigRootDir` and would break type-aware
 * linting for the rest of the repository. Types are checked separately with
 * `npx tsc -p tests/e2e/tsconfig.json --noEmit`.
 *
 * Playwright specs print the measured bench numbers, which is the point of
 * running them, so `console` is a declared global rather than a violation.
 */
export default [
  { ignores: ['__screenshots__/**', 'test-results/**', 'playwright-report/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { projectService: false, tsconfigRootDir: import.meta.dirname },
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        navigator: 'readonly',
        window: 'readonly',
        document: 'readonly',
        HTMLCanvasElement: 'readonly',
        globalThis: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      // The TypeScript compiler already reports these, and it understands type-only
      // declarations, which the core rule does not.
      'no-unused-vars': 'off',
    },
  },
];

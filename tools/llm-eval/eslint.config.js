import tsParser from '@typescript-eslint/parser';

/**
 * The eval harness is TypeScript, and the root flat config only wires the
 * TypeScript parser for `packages/`, `templates/` and `examples/`. ESLint 10
 * resolves a config from the linted file's own directory upwards, so this file
 * governs `tools/llm-eval/**` and nothing else.
 *
 * Deliberately plain, exactly like `tests/e2e/eslint.config.js`: it does not
 * call `tseslint.config()`, because that registers a second candidate
 * `tsconfigRootDir` and would break type-aware linting for the rest of the
 * repository. Types are checked separately with
 * `npx tsc -p tools/llm-eval/tsconfig.json --noEmit`.
 *
 * The harness is a command-line tool whose entire output is `console`, so
 * `console` is a declared global rather than a violation.
 */
export default [
  { ignores: ['node_modules/**', 'results/**'] },
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
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        performance: 'readonly',
        globalThis: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      // The TypeScript compiler already reports these, and it understands
      // type-only declarations, which the core rule does not.
      'no-unused-vars': 'off',
    },
  },
];

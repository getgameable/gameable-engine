import tsParser from '@typescript-eslint/parser';

/**
 * Boundary tests are TypeScript, and the root flat config only wires the
 * TypeScript parser for `packages/`, `templates/` and `examples/`. ESLint 10
 * resolves a config from the linted file's own directory upwards, so this file
 * governs `tests/boundary/**` and nothing else.
 *
 * Deliberately plain: it does not call `tseslint.config()`, because that
 * registers a second candidate `tsconfigRootDir` and would break type-aware
 * linting for the rest of the repository.
 */
export default [
  { ignores: ['build/**', 'node_modules/**'] },
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { projectService: false, tsconfigRootDir: import.meta.dirname },
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        globalThis: 'readonly',
        WebAssembly: 'readonly',
        performance: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'off',
    },
  },
];

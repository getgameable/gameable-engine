import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import tseslint from 'typescript-eslint';

import gameable from './tools/eslint/gameable-rules.js';

/** Globals available in node scripts (tools, config files). */
const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  fetch: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
};

/** Contexts that count as "an exported symbol" for JSDoc rules. */
const exportedContexts = ['ExportNamedDeclaration[declaration!=null]', 'ExportDefaultDeclaration'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'packages/*/src/**/vendor/**',
      '**/dist/**',
      '**/build/**',
      '**/.vite/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'docs/.vitepress/cache/**',
      'docs/.vitepress/dist/**',
      'docs/api/**',
      'docs/public/play/**',
      'examples/wasm-hello/public/characters/greeter/**',
      'docs/wit/**',
      'packages/*/src/generated/**',
    ],
  },

  js.configs.recommended,

  // Node-side JavaScript: tooling, eslint config, generators.
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals,
    },
  },

  // Engine packages: the strictest tier, plus the local hard rules.
  {
    files: ['packages/**/src/**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked, jsdoc.configs['flat/recommended-typescript']],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { gameable },
    rules: {
      'gameable/no-bare-three-import': 'error',
      // TSDoc is authored for humans and for the docs generator; the plugin's
      // type-annotation rules are redundant under TypeScript.
      'jsdoc/require-param-type': 'off',
      'jsdoc/require-returns-type': 'off',
      // One blank line between the description and the first tag reads better
      // and is what the docs generator expects.
      'jsdoc/tag-lines': ['error', 'any', { startLines: 1 }],
    },
  },

  // Every exported symbol in a package entry point needs a runnable @example.
  {
    files: ['packages/*/src/index.ts'],
    rules: {
      'jsdoc/require-jsdoc': ['error', { contexts: exportedContexts, require: {} }],
      'jsdoc/require-example': [
        'error',
        { contexts: exportedContexts, exemptNoArguments: false, checkConstructors: false },
      ],
    },
  },

  // Game-facing code: type-aware, but not pedantic.
  {
    files: ['templates/**/*.ts', 'examples/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { gameable },
    rules: {
      'gameable/no-bare-three-import': 'error',
    },
  },

  // Root config files are TypeScript but are not part of any package project.
  {
    files: ['*.config.ts', 'packages/*/tsdown.config.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { projectService: false },
    },
  },

  // Tests may use non-null assertions and unbound expectations freely.
  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'jsdoc/require-jsdoc': 'off',
    },
  },
);

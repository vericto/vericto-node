// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // examples/ and docs/ import the published package names and optional drivers; they
  // are documentation, not part of the build (scripts/check-docs-examples.mjs type-checks
  // and runs the docs' examples, in .docs-check/).
  { ignores: ['dist/', 'node_modules/', 'coverage/', 'examples/', 'docs/', '.docs-check/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['eslint.config.js', 'scripts/*.mjs'] } },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        setImmediate: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);

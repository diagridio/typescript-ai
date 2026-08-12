// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.tsbuild/**',
    ],
  },
  js.configs.recommended,

  // Type-aware linting across the whole workspace. `projectService` lets
  // typescript-eslint find each file's owning tsconfig (including
  // `tests/tsconfig.json`) without maintaining a parallel list here.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Build and test-harness configs sit outside the composite projects
          // on purpose (they are tooling, not shipped code), so name them here
          // to get type-aware linting without adding them to a tsconfig
          // `include` and dragging them into the published declarations.
          allowDefaultProject: [
            'eslint.config.mjs',
            'vitest.config.ts',
            'packages/*/tsup.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ['**/*.ts'],
    rules: {
      // The adapter bodies are deliberately unfinished. Allow `_`-prefixed
      // parameters (the stub signatures keep the real parameter names visible
      // as documentation) while still flagging genuinely dead locals.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Framework introspection reads objects we do not own, so `unknown`
      // narrowing is pervasive and explicit type assertions are the honest
      // tool. `no-unsafe-*` on top of that produces noise, not safety.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      // Prefer `type` imports so `verbatimModuleSyntax` never emits a runtime
      // import for something that only exists in the type system — that is what
      // keeps the Mastra peer dependency out of the runtime graph.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      // A floating promise in a workflow activity silently drops durability
      // guarantees, so this stays an error rather than a warning.
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },

  // Test files reach into internals and assert on `any`-shaped payloads.
  {
    files: ['tests/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  // Build/config files are plain Node scripts, not part of a composite project.
  {
    files: ['*.config.ts', '*.config.mjs', 'packages/*/tsup.config.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  // Must stay last: turns off every stylistic rule Prettier owns.
  prettier
);

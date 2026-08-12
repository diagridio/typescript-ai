// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Workspace-resolution aliases.
 *
 * Mirror of the `paths` block in `tsconfig.base.json`: tests import the
 * workspace packages by their published names but resolve to source, so the
 * suite runs on a clean checkout without a build step and coverage is reported
 * against real source lines rather than bundles.
 */
const alias = {
  '@diagrid/agent-core': resolve('./packages/core/src/index.ts'),
  '@diagrid/agent-mastra': resolve('./packages/mastra/src/index.ts'),
};

/**
 * The `integration` split.
 *
 * This is the Vitest equivalent of `pytest -m "not integration"` in
 * `diagridio/python-ai`: the marker is the `.integration.test.ts` filename
 * suffix rather than a decorator, and the two lanes are separate Vitest
 * projects.
 *
 *   pnpm test              -> unit only (what PRs gate on)
 *   pnpm test:integration  -> integration only (nightly + the Ollama e2e lane)
 *
 * A file suffix rather than a `describe` tag is deliberate: it is greppable,
 * it cannot be applied by accident halfway down a file, and it lets the two
 * lanes differ in timeout and concurrency, which tag filtering cannot.
 */
const INTEGRATION_GLOB = 'tests/**/*.integration.test.ts';
const UNIT_GLOBS = ['tests/**/*.test.ts', 'packages/**/*.test.ts'];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: UNIT_GLOBS,
          exclude: ['**/node_modules/**', '**/dist/**', INTEGRATION_GLOB],
          environment: 'node',
          setupFiles: ['./tests/setup.unit.ts'],
          // Guard tests spawn Node subprocesses to check import isolation;
          // 30s covers a cold process start on a loaded CI runner.
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: [INTEGRATION_GLOB],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
          // Deliberately no setup file: the unit setup scrubs `DAPR_*` and
          // `OTEL_*` from the environment, which is exactly the configuration
          // an integration run needs to keep.
          environmentOptions: {},
          // Real sidecars, real models: minutes, not seconds. Run serially so
          // concurrent workflows cannot contend on one Dapr sidecar.
          testTimeout: 300_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      // Barrel files and version stamps are re-exports and constants; counting
      // them inflates coverage without telling anyone anything.
      exclude: ['packages/*/src/index.ts', 'packages/*/src/version.ts'],
    },
  },
});

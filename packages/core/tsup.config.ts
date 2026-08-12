// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // Dual output: ESM is the primary target, CJS is emitted so the adapters
  // remain consumable from `require()`-based Node services (a lot of existing
  // Dapr-on-Node deployments are still CJS).
  format: ['esm', 'cjs'],
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  target: 'node22',
  tsconfig: './tsconfig.build.json',
  platform: 'node',
  // Point the declaration step at the non-composite build config; see
  // ./tsconfig.build.json.
  dts: { tsconfig: './tsconfig.build.json' },
  sourcemap: true,
  clean: true,
  // Every runtime dependency stays external — this package is a library, not
  // an application bundle. Bundling `@dapr/dapr` would duplicate its gRPC
  // client in each adapter.
  skipNodeModulesBundle: true,
  treeshake: true,
});

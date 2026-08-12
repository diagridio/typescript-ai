// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
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
  // `@mastra/core` is a peer dependency and `@diagrid/agent-core` is a runtime
  // dependency — neither may be inlined. Bundling Mastra here would give an
  // application two copies of its agent registry; bundling core would give it
  // two Dapr workflow runtimes. `external` is belt-and-braces on top of the
  // cleared `paths` in tsconfig.build.json.
  external: ['@diagrid/agent-core', '@mastra/core'],
  skipNodeModulesBundle: true,
  treeshake: true,
});

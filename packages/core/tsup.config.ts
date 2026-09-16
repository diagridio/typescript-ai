// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import { defineConfig } from 'tsup';

export default defineConfig({
  // Three entry points, not one. The two web adapters ship as
  // `@diagrid/agent-core/express` and `@diagrid/agent-core/fastify` so their
  // declarations — which cannot avoid naming `express` and `fastify` — stay
  // out of `dist/index.d.ts`, and so `fastify-plugin` stays out of
  // `dist/index.js`. See the head of `src/identity/express.ts`.
  entry: {
    index: 'src/index.ts',
    express: 'src/identity/express.ts',
    fastify: 'src/identity/fastify.ts',
  },
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
  // Shared internals — `./identity/authenticate`, and above all the
  // `AsyncLocalStorage` in `./identity/outbound` — must exist once per format,
  // not once per entry point: two copies of that storage would mean a handler
  // reached through the Express entry could not read back the token the
  // middleware put there. Splitting is what gives all three entry points one
  // chunk to share.
  splitting: true,
  treeshake: true,
});

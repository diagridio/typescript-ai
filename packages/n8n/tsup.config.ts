// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entry points, unlike the single-entry adapter shape mastra uses:
  // `index.ts` is the library surface (types, the registration function,
  // programmatic access), `preload.ts` is what `NODE_OPTIONS="--require
  // @diagrid/n8n/register"` actually loads — see preload.ts's own doc comment
  // for why it stays separate from register.ts (no import-time side effect
  // on the library entrypoint).
  entry: { index: 'src/index.ts', preload: 'src/preload.ts' },
  format: ['esm', 'cjs'],
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  target: 'node22',
  tsconfig: './tsconfig.build.json',
  platform: 'node',
  dts: { tsconfig: './tsconfig.build.json' },
  sourcemap: true,
  clean: true,
  // Every runtime dependency and peer stays external — bundling any of them
  // would either duplicate `@diagrid/agent-core`/`@dapr/dapr` across every
  // consumer (the exact mistake `tests/guards/cross-framework-imports.test.ts`
  // exists to catch for the shared core) or ship a second, possibly
  // mismatched copy of n8n's own packages into a process that already has the
  // real ones loaded — which would break the monkeypatch this package relies
  // on (see README: the patch target has to be the exact same class
  // reference the host n8n process uses).
  external: [
    '@diagrid/agent-core',
    '@dapr/dapr',
    'n8n-core',
    'n8n-workflow',
    'n8n-nodes-base',
    '@n8n/db',
    '@n8n/di',
    'zod',
  ],
  skipNodeModulesBundle: true,
  treeshake: true,
});

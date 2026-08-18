// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Guard: the built packages actually load and work.
 *
 * Everything else in this repo runs from source. `tsx` and Vitest both honour
 * the root `tsconfig.base.json` `paths` aliases, so an example that looks like
 * it imports `@diagrid/agent-mastra` really loads
 * `packages/mastra/src/index.ts` — confirmed from a stack frame reading
 * `at Module.createModelInvoker (/packages/mastra/src/bridge.ts)`. Every lane
 * runs `pnpm build` and then nothing looks at the output.
 *
 * That is how the `exports` map shipped broken: `types` sat above
 * `import`/`require`, so the `.d.cts` in both tarballs was never resolved by
 * anything and a CJS consumer on `node16` got `TS1479`. `attw --pack` in
 * `build.yaml` now covers the *type* half of that. This covers the runtime half:
 * a packaging change that breaks `require()` or `import` of the real artifact.
 *
 * Both module systems are loaded on purpose. `main` points at `dist/index.cjs`
 * and `exports.import` at `dist/index.js`; they are separate tsup outputs, and a
 * regression in one is invisible from the other.
 *
 * These assertions are about the *artifact*, not about behaviour — behaviour is
 * covered from source everywhere else. Keep it to "it loads, its exports are
 * present, and a representative value works".
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);

interface Artifact {
  readonly pkg: string;
  /** A few exports that must survive any bundling change. */
  readonly expected: readonly string[];
}

const ARTIFACTS: readonly Artifact[] = [
  {
    pkg: 'core',
    expected: [
      'BaseWorkflowRunner',
      'BaseAgentMapper',
      'DaprStateStore',
      'WorkflowRuntimeStatus',
      'buildWorkflowName',
      'VERSION',
    ],
  },
  {
    pkg: 'mastra',
    expected: [
      'DaprWorkflowAgentRunner',
      'MastraAgentMapper',
      'DaprMastraCheckpointer',
      'agentWorkflow',
      'createModelInvoker',
      'VERSION',
    ],
  },
];

const distFile = (pkg: string, file: string) =>
  join(ROOT, 'packages', pkg, 'dist', file);

describe.each(ARTIFACTS)('$pkg dist', ({ pkg, expected }) => {
  // Deliberately a failure, not a skip: `make ci` and every CI lane build before
  // testing, so a missing artifact means the build broke or the order changed —
  // and a guard that quietly skips is how the exports-map bug survived.
  it('has been built', () => {
    for (const file of ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts']) {
      expect(
        existsSync(distFile(pkg, file)),
        `packages/${pkg}/dist/${file} is missing — run \`pnpm build\` first`
      ).toBe(true);
    }
  });

  it('loads as CommonJS with its exports intact', () => {
    // What `main` resolves to, i.e. what `require('@diagrid/agent-…')` gets.
    const loaded = require_(distFile(pkg, 'index.cjs')) as Record<
      string,
      unknown
    >;

    for (const name of expected) {
      expect(
        loaded[name],
        `${name} is missing from the CJS bundle`
      ).toBeDefined();
    }
  });

  it('loads as ESM with its exports intact', async () => {
    // pathToFileURL, not a bare path: importing an absolute Windows path throws
    // ERR_UNSUPPORTED_ESM_URL_SCHEME, and this suite runs on the Windows leg.
    const loaded = (await import(
      pathToFileURL(distFile(pkg, 'index.js')).href
    )) as Record<string, unknown>;

    for (const name of expected) {
      expect(
        loaded[name],
        `${name} is missing from the ESM bundle`
      ).toBeDefined();
    }
  });
});

/**
 * A require anchored where a real consumer sits.
 *
 * `examples/mastra` declares `@diagrid/agent-mastra` as a dependency, so pnpm
 * links it into that directory's `node_modules` — which makes it the only place
 * in this repo where resolution *by package name* behaves as it will for an
 * installed consumer. The root has no such link.
 *
 * This matters because the by-path loads above deliberately bypass the
 * `exports` map, and the map is what shipped broken. Resolving by name runs the
 * real algorithm: `require` condition, `main`, and the nested `exports` entry.
 */
const consumerRequire = createRequire(
  join(ROOT, 'examples/mastra/package.json')
);

/** Compare paths without caring which separator the platform uses. */
const normalize = (path: string) => path.replaceAll('\\', '/');

describe('resolution through the exports map', () => {
  it('resolves the adapter by name to its built CJS bundle', () => {
    // If `exports.require` regresses, this resolves somewhere else — or throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED — rather than silently loading source.
    expect(normalize(consumerRequire.resolve('@diagrid/agent-mastra'))).toMatch(
      /\/packages\/mastra\/dist\/index\.cjs$/
    );
  });

  it('yields working exports when resolved by name', () => {
    const loaded = consumerRequire('@diagrid/agent-mastra') as Record<
      string,
      unknown
    >;

    expect(typeof loaded['DaprWorkflowAgentRunner']).toBe('function');
    expect(typeof loaded['agentWorkflow']).toBe('function');
  });

  it('resolves the shared core by name from inside the adapter', () => {
    // The adapter's own dependency edge. `pnpm pack` rewrites `workspace:*` to a
    // concrete version, so if this edge is wrong the published adapter depends on
    // something that cannot resolve.
    const fromAdapter = createRequire(
      join(ROOT, 'packages/mastra/package.json')
    );

    expect(normalize(fromAdapter.resolve('@diagrid/agent-core'))).toMatch(
      /\/packages\/core\/dist\/index\.cjs$/
    );
  });
});

describe('the built artifacts are usable, not merely loadable', () => {
  it('derives a workflow name from core', () => {
    const core = require_(distFile('core', 'index.cjs')) as {
      buildWorkflowName: (framework: string, agent: string) => string;
      WorkflowRuntimeStatus: Record<string, number>;
    };

    expect(core.buildWorkflowName('Mastra', 'support-agent')).toBe(
      'dapr.mastra.SupportAgent.workflow'
    );
    // A value export, and the one that was briefly `export type` — unusable at
    // runtime while compiling perfectly.
    expect(core.WorkflowRuntimeStatus['COMPLETED']).toBe(1);
  });

  it('constructs a runner from the mastra bundle without a sidecar', () => {
    // The documented "no sidecar at construction time" claim, checked against
    // the artifact a consumer installs rather than against source.
    const { DaprWorkflowAgentRunner } = require_(
      distFile('mastra', 'index.cjs')
    ) as {
      DaprWorkflowAgentRunner: new (options: unknown) => {
        workflowName: string;
      };
    };

    const runner = new DaprWorkflowAgentRunner({
      agent: {
        name: 'support-agent',
        getInstructions: () => 'help',
        generate: () => Promise.resolve({}),
      },
      name: 'support-agent',
    });

    expect(runner.workflowName).toBe('dapr.mastra.SupportAgent.workflow');
  });
});

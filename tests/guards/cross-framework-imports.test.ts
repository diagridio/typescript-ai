// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Guard: adapter isolation.
 *
 * The TypeScript counterpart of
 * `tests/agent/core/test_cross_framework_imports.py` in `diagridio/python-ai`,
 * and — like it — wired directly into CI (`.github/workflows/deps-check.yaml`)
 * rather than left to the general test sweep.
 *
 * The failure it prevents: a Dependabot bump, or a careless import, that makes
 * `@diagrid/agent-mastra` drag another framework's SDK into an application
 * that only asked for Mastra. In Python that showed up as OpenTelemetry pin
 * conflicts between adapters; in Node it shows up as install bloat and
 * duplicate framework singletons. Either way, it must fail in seconds here
 * instead of after 20 minutes in the Ollama e2e lane.
 *
 * Three layers, cheapest first:
 *
 * 1. **Registry parity** — the `ADAPTERS` table must enumerate every adapter
 *    on disk, so a new `packages/<framework>/` cannot land without coverage.
 * 2. **Static dependency isolation** — an adapter's runtime `dependencies` may
 *    contain only the shared core; its own framework SDK must be a *peer*.
 * 3. **Runtime import isolation** — each adapter's built entrypoint imports
 *    cleanly in a fresh Node process and exposes its runner. Skipped with an
 *    explicit reason when `dist/` is absent; the CI lane builds first, so it
 *    always runs there.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

/** The shared runtime. Not an adapter — every adapter depends on it. */
const CORE_PACKAGE_DIR = 'core';
const CORE_PACKAGE_NAME = '@diagrid/agent-core';

interface AdapterSpec {
  /** Directory under `packages/`. */
  readonly dir: string;
  /** Published package name. */
  readonly pkg: string;
  /** Symbol the adapter must export — a partially-broken import would
   *  otherwise resolve to an empty module and pass. */
  readonly runner: string;
  /** The framework SDK this adapter wraps. Must be a peer dependency. */
  readonly frameworkPeer: string;
}

/**
 * Every framework adapter in this repo.
 *
 * Add an entry here when you add a `packages/<framework>/` directory —
 * `adapter table matches the filesystem` below fails until you do.
 */
const ADAPTERS: readonly AdapterSpec[] = [
  {
    dir: 'mastra',
    pkg: '@diagrid/agent-mastra',
    runner: 'DaprWorkflowAgentRunner',
    frameworkPeer: '@mastra/core',
  },
];

interface PackageManifest {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readManifest(dir: string): PackageManifest {
  return JSON.parse(
    readFileSync(join(PACKAGES_DIR, dir, 'package.json'), 'utf8')
  ) as PackageManifest;
}

const distEntry = (dir: string) => join(PACKAGES_DIR, dir, 'dist', 'index.js');
const allDistsBuilt = ADAPTERS.every((a) => existsSync(distEntry(a.dir)));

/** Import a module in a fresh Node process and assert it exports `symbol`. */
function importInFreshProcess(specifier: string, symbol: string): void {
  const script = `
    const mod = await import(${JSON.stringify(specifier)});
    if (typeof mod[${JSON.stringify(symbol)}] === 'undefined') {
      throw new Error('missing export ${symbol}');
    }
  `;

  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('adapter registry', () => {
  it('matches the filesystem', () => {
    const onDisk = readdirSync(PACKAGES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== CORE_PACKAGE_DIR)
      .map((entry) => entry.name)
      .sort();
    const listed = ADAPTERS.map((a) => a.dir).sort();

    expect(listed).toEqual(onDisk);
  });

  it('lists each adapter under its real published name', () => {
    for (const adapter of ADAPTERS) {
      expect(readManifest(adapter.dir).name).toBe(adapter.pkg);
    }
  });
});

describe('static dependency isolation', () => {
  it.each(ADAPTERS)(
    '$pkg depends on nothing but the shared core at runtime',
    (adapter) => {
      const deps = Object.keys(readManifest(adapter.dir).dependencies ?? {});

      // The adapter's runtime graph is exactly: the shared core. Everything
      // else — the framework SDK, zod — is a peer supplied by the host app.
      expect(deps).toEqual([CORE_PACKAGE_NAME]);
    }
  );

  it.each(ADAPTERS)(
    '$pkg declares $frameworkPeer as a peer, not a dependency',
    (adapter) => {
      const manifest = readManifest(adapter.dir);

      expect(manifest.peerDependencies ?? {}).toHaveProperty(
        adapter.frameworkPeer
      );
      expect(manifest.dependencies ?? {}).not.toHaveProperty(
        adapter.frameworkPeer
      );
      // A devDependency is required so the adapter can be type-checked and
      // tested against a real version of the framework.
      expect(manifest.devDependencies ?? {}).toHaveProperty(
        adapter.frameworkPeer
      );
    }
  );

  it('keeps every other framework out of each adapter', () => {
    const allFrameworkPeers = ADAPTERS.map((a) => a.frameworkPeer);

    for (const adapter of ADAPTERS) {
      const manifest = readManifest(adapter.dir);
      const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ]);
      const foreign = allFrameworkPeers.filter(
        (peer) => peer !== adapter.frameworkPeer && declared.has(peer)
      );

      expect(foreign).toEqual([]);
    }
  });

  it('keeps framework SDKs out of the shared core entirely', () => {
    // The moment core depends on a framework, every adapter inherits it and
    // the isolation above becomes decorative.
    const manifest = readManifest(CORE_PACKAGE_DIR);
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    const leaked = ADAPTERS.map((a) => a.frameworkPeer).filter((peer) =>
      declared.has(peer)
    );

    expect(leaked).toEqual([]);
  });
});

describe.skipIf(!allDistsBuilt)('runtime import isolation', () => {
  it.each(ADAPTERS)('$pkg imports cleanly in a fresh process', (adapter) => {
    expect(() =>
      importInFreshProcess(distEntry(adapter.dir), adapter.runner)
    ).not.toThrow();
  });

  it('every adapter can be imported into one process', () => {
    // Catches module-level conflicts between adapters: two frameworks fighting
    // over a global tracer provider, or two copies of a singleton registry.
    const imports = ADAPTERS.map(
      (a) =>
        `const m${a.dir} = await import(${JSON.stringify(distEntry(a.dir))});` +
        `if (!m${a.dir}[${JSON.stringify(a.runner)}]) throw new Error('missing ${a.runner}');`
    ).join('\n');

    const script = `
      ${imports}
      const core = await import(${JSON.stringify(join(PACKAGES_DIR, CORE_PACKAGE_DIR, 'dist', 'index.js'))});
      if (typeof core.getTracer !== 'function') throw new Error('core.getTracer missing');
    `;

    expect(() =>
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 60_000,
      })
    ).not.toThrow();
  });

  it.each(ADAPTERS)(
    '$pkg does not bundle its framework or the shared core',
    (adapter) => {
      // The manifest checks above state the intent; this one checks the
      // artefact. tsup inlining `@mastra/core` or `@diagrid/agent-core` would
      // satisfy every manifest assertion while still shipping a second copy of
      // the framework to every consumer — a mistake this repo has already made
      // once during setup (see the `paths` note in tsconfig.build.json).
      const bundle = readFileSync(distEntry(adapter.dir), 'utf8');

      for (const external of [adapter.frameworkPeer, CORE_PACKAGE_NAME]) {
        if (!bundle.includes(external)) {
          continue;
        }
        // Present is fine — as an import specifier. Inlined is not.
        expect(
          new RegExp(`from\\s*["']${external}["']`).test(bundle),
          `${external} appears in ${adapter.pkg}'s bundle but not as an import — it looks inlined`
        ).toBe(true);
      }
    }
  );
});

describe('runtime import isolation (prerequisite)', () => {
  it('reports when the built output is missing', () => {
    // Not an assertion about the code — a signal to whoever reads a local run
    // that a whole layer of this guard was skipped. CI builds first (see
    // deps-check.yaml), so it never skips there.
    if (!allDistsBuilt) {
      console.warn(
        '[guard] runtime import isolation skipped: run `pnpm build` first ' +
          '(CI does this in .github/workflows/deps-check.yaml).'
      );
    }
    expect(typeof allDistsBuilt).toBe('boolean');
  });
});

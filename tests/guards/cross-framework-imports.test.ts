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
 *
 * `@diagrid/n8n` (`packages/n8n`) is covered too, but deliberately NOT through
 * `ADAPTERS`: it isn't a framework adapter in the sense this file's isolation
 * invariant models (n8n workflows aren't LLM agents — no `SupportedFrameworks`
 * entry, no `BaseAgentMapper` — see `packages/n8n/README.md`'s "Why not
 * `SupportedFrameworks`" section), and its real runtime dependency list is NOT
 * `[@diagrid/agent-core]` alone: it needs `@dapr/dapr` directly, since it
 * can't subclass `BaseWorkflowRunner` to get that dependency for free the way
 * every adapter here does. Forcing it into `ADAPTERS` would either fail the
 * `deps === [CORE_PACKAGE_NAME]` assertion outright or silently weaken that
 * assertion for every real adapter too — so it gets its own, separately
 * justified set of checks below instead, asserting what's actually true of it
 * rather than pretending it fits the adapter shape.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';
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

/**
 * `@diagrid/n8n` — real, and covered below, but deliberately not an
 * `AdapterSpec`: see this file's own top-of-file doc comment for why.
 */
const N8N_DIR = 'n8n';
const N8N_PKG = '@diagrid/n8n';
const N8N_RUNNER = 'getRuntime';
/** The real, deliberate divergence — see `packages/n8n/README.md`. */
const DAPR_PACKAGE_NAME = '@dapr/dapr';
/** n8n's own five peers, satisfied by whatever real n8n install this attaches to. */
const N8N_PEERS = [
  'n8n-core',
  'n8n-workflow',
  'n8n-nodes-base',
  '@n8n/db',
  '@n8n/di',
] as const;

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

/**
 * A path in the form dynamic `import()` accepts on every platform.
 *
 * On POSIX, `import('/abs/path')` happens to work. On Windows it does not:
 * `import('D:\\a\\...')` throws ERR_UNSUPPORTED_ESM_URL_SCHEME because the
 * loader reads `D:` as a URL scheme. Absolute paths must be `file://` URLs, so
 * every specifier handed to a subprocess goes through here.
 */
const importSpecifier = (path: string) => pathToFileURL(path).href;
const allDistsBuilt = ADAPTERS.every((a) => existsSync(distEntry(a.dir)));

/** Import a module in a fresh Node process and assert it exports `symbol`. */
function importInFreshProcess(specifier: string, symbol: string): void {
  const script = `
    const mod = await import(${JSON.stringify(importSpecifier(specifier))});
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

// The manifest checks above state the intent; these check the artefact. tsup
// inlining a dependency would satisfy every manifest assertion while still
// shipping a second copy of it to each consumer — a mistake this repo made
// once already (see the `paths` note in tsconfig.build.json).
//
// The two dependencies need *opposite* assertions, which an earlier single
// test got wrong. It flagged any textual occurrence of a package name that
// wasn't an import as "inlined", and duly failed on the string
// `'expected a Mastra Agent from @mastra/core/agent.'` inside an error
// message. A substring search cannot tell code from prose; assert on imports
// instead.
//
// The pattern must cover every form that is a real runtime import, not just
// the two obvious ones. An earlier version matched only `from '…'` and
// `require('…')`, which a bare side-effect import (`import '@mastra/core'`) or
// a dynamic one (`await import('@mastra/core')`) walked straight past — and
// the dynamic form is exactly what is tempting in `bridge.ts` if someone
// replaces the duck-typed `generate` check with `instanceof Agent`.
//
// Module-scoped (not defined inside the ADAPTERS-only `runtime import
// isolation` describe block below): the n8n-specific runtime isolation block
// further down needs the exact same AST-based check — for the opposite
// assertion direction on `@dapr/dapr` (n8n SHOULD import it, not inline it —
// see that block's own doc comment) — and duplicating a parser this
// carefully commented would be its own maintenance risk.
/**
 * Every module specifier the file imports at runtime, read from the AST.
 *
 * Text matching cannot do this job, and this guard hit both of its failure
 * directions while it was being written:
 *
 * - **False positive**, which shipped. An earlier version flagged any occurrence of a package
 *   name and failed on the string `'expected a Mastra Agent from
 *   @mastra/core/agent.'` inside an error message.
 * - **False negative**, caught before it shipped. Stripping comments with a
 *   regex before matching is
 *   worse than it looks: `/\*` inside a *string literal* opens a comment as
 *   far as the regex is concerned, and everything up to the next comment terminator — a real
 *   `import('@mastra/core/agent')` included — disappears from the text being
 *   searched. The guard then passes while the bundle does the exact thing it
 *   exists to forbid.
 *
 * A parser has no such ambiguity: string literals, comments, and regex
 * literals are distinct nodes, so prose is skipped and code is not. The cost
 * is parsing a few hundred KB in a test, which is immaterial.
 */
function importedModules(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    // setParentNodes: needed to tell `import type` from a value import.
    true,
    /\.c?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  );

  const specifiers: string[] = [];

  const record = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) {
      specifiers.push(node.text);
    }
  };

  const visit = (node: ts.Node): void => {
    // `import … from '…'`, a bare `import '…'`, and `export … from '…'`.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      // A type-only import is erased before it reaches a consumer, so it is
      // not a runtime import and must not fail the framework check — which is
      // the whole point of `import type { Agent }` in the mapper.
      const typeOnly = ts.isImportDeclaration(node)
        ? node.importClause?.isTypeOnly
        : node.isTypeOnly;
      if (!typeOnly) {
        record(node.moduleSpecifier);
      }
    }

    // Any call argument that is a bare module specifier.
    //
    // Deliberately broader than `import(…)`/`require(…)`, because matching on
    // the *callee* misses every indirection — and one of them is a two-line
    // bypass demonstrated against an earlier version of this guard:
    //
    //   const req = createRequire(import.meta.url);
    //   req('@mastra/core');          // callee is `req`, not `require`
    //
    // That bundle genuinely loaded the framework at runtime and the guard
    // passed. So the argument is what gets inspected, not the callee.
    //
    // Prose stays safe because the comparison is against the *whole* string:
    // the error message `'… expected a Mastra Agent from @mastra/core/agent.'`
    // is a sentence, not a specifier, so it does not match.
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      for (const argument of node.arguments ?? []) {
        record(argument);
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return specifiers;
}

/**
 * Does this file import `pkg`, or any subpath of it, at runtime?
 *
 * The known limit, stated rather than papered over: a specifier assembled at
 * runtime (`load('@mastra' + '/core')`, or read from a variable) is invisible
 * to any static check. The bundle-size backstop below is the only thing that
 * would notice such a case, and only if the framework were inlined outright.
 */
function importsPkg(path: string, pkg: string): boolean {
  return importedModules(path).some(
    (specifier) => specifier === pkg || specifier.startsWith(`${pkg}/`)
  );
}

/**
 * Every artefact a consumer can load, not just the ESM entry.
 *
 * `package.json` sets `main` to `dist/index.cjs`, which is what CJS consumers
 * get, and the declaration files are produced by a *different* tsconfig — so a
 * regression in either was previously invisible.
 */
function artefacts(dir: string, base = 'index'): string[] {
  return [`${base}.js`, `${base}.cjs`, `${base}.d.ts`, `${base}.d.cts`]
    .map((file) => join(PACKAGES_DIR, dir, 'dist', file))
    .filter((path) => existsSync(path));
}

describe('adapter registry', () => {
  it('matches the filesystem', () => {
    // Every package under packages/ must be accounted for by SOMETHING below
    // — either a true adapter (ADAPTERS) or n8n's own, separately-justified
    // shape (N8N_DIR) — so a new packages/<x>/ cannot land uncovered either
    // way.
    const onDisk = readdirSync(PACKAGES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== CORE_PACKAGE_DIR)
      .map((entry) => entry.name)
      .sort();
    const listed = [...ADAPTERS.map((a) => a.dir), N8N_DIR].sort();

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

/**
 * `@diagrid/n8n`'s own real shape — not an `AdapterSpec`, so not covered by
 * the block above, but not exempt either. Asserts what is ACTUALLY true of
 * this package (core + `@dapr/dapr` at runtime, five n8n-specific peers)
 * rather than the adapter invariant it deliberately doesn't satisfy.
 */
describe('n8n dependency isolation (not a framework adapter)', () => {
  it('is named under its real published name', () => {
    expect(readManifest(N8N_DIR).name).toBe(N8N_PKG);
  });

  it('depends on core AND @dapr/dapr at runtime — not core alone, unlike every adapter', () => {
    const deps = Object.keys(readManifest(N8N_DIR).dependencies ?? {}).sort();

    // The real, plainly-stated consequence of not going through
    // BaseWorkflowRunner (see packages/n8n/README.md) — this is the ONE
    // package in this workspace for which the strict
    // `deps === [CORE_PACKAGE_NAME]` invariant above must NOT hold.
    expect(deps).toEqual([CORE_PACKAGE_NAME, DAPR_PACKAGE_NAME].sort());
  });

  it('pins @dapr/dapr to the same version the workspace itself depends on', () => {
    // Not re-exported the way core re-exports Dapr's *types* (workflow/dapr.ts)
    // — there is no static import that would force this — so this is the one
    // guard standing between this package and silently drifting onto a
    // different @dapr/dapr version than the rest of the workspace was tested
    // against.
    const rootPkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
    ) as PackageManifest;
    const n8nPkg = readManifest(N8N_DIR);

    expect(n8nPkg.dependencies?.[DAPR_PACKAGE_NAME]).toBe(
      rootPkg.devDependencies?.[DAPR_PACKAGE_NAME]
    );
  });

  it.each(N8N_PEERS)('declares %s as a peer, not a dependency', (peer) => {
    const manifest = readManifest(N8N_DIR);

    expect(manifest.peerDependencies ?? {}).toHaveProperty(peer);
    expect(manifest.dependencies ?? {}).not.toHaveProperty(peer);
  });

  it('marks all five n8n peers optional — a real install satisfies them, this workspace never does', () => {
    const manifest = readManifest(N8N_DIR) as PackageManifest & {
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };

    for (const peer of N8N_PEERS) {
      expect(manifest.peerDependenciesMeta?.[peer]?.optional).toBe(true);
    }
  });

  it("never depends on any framework adapter's own peer", () => {
    const manifest = readManifest(N8N_DIR);
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    const foreign = ADAPTERS.map((a) => a.frameworkPeer).filter((peer) =>
      declared.has(peer)
    );

    expect(foreign).toEqual([]);
  });

  it("keeps n8n's own peers, and @dapr/dapr as a runtime dependency, out of every framework adapter", () => {
    for (const adapter of ADAPTERS) {
      const manifest = readManifest(adapter.dir);
      const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ]);
      const leaked = [...N8N_PEERS, DAPR_PACKAGE_NAME].filter((name) =>
        declared.has(name)
      );

      expect(leaked).toEqual([]);
    }
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
        `const m${a.dir} = await import(${JSON.stringify(importSpecifier(distEntry(a.dir)))});` +
        `if (!m${a.dir}[${JSON.stringify(a.runner)}]) throw new Error('missing ${a.runner}');`
    ).join('\n');

    const script = `
      ${imports}
      const core = await import(${JSON.stringify(importSpecifier(join(PACKAGES_DIR, CORE_PACKAGE_DIR, 'dist', 'index.js')))});
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

  // The manifest checks above state the intent; these check the artefact —
  // via `importedModules`/`importsPkg`/`artefacts`, module-scoped above this
  // describe block (the n8n-specific block further down needs the exact same
  // AST-based check, for the opposite assertion direction on `@dapr/dapr`).
  // tsup inlining a dependency would satisfy every manifest assertion while
  // still shipping a second copy of it to each consumer — a mistake this
  // repo made once already (see the `paths` note in tsconfig.build.json).

  it.each(ADAPTERS)(
    '$pkg imports the shared core rather than inlining it',
    (adapter) => {
      // Only the executable artefacts: a .d.ts re-exports types, which does not
      // require a runtime import of core.
      for (const path of artefacts(adapter.dir).filter((p) =>
        /\.c?js$/.test(p)
      )) {
        expect(
          importsPkg(path, CORE_PACKAGE_NAME),
          `${path} does not import ${CORE_PACKAGE_NAME} — it looks inlined`
        ).toBe(true);
      }
    }
  );

  it.each(ADAPTERS)(
    '$pkg never imports $frameworkPeer at runtime',
    (adapter) => {
      // The stronger invariant, and the reason the mapper duck-types instead of
      // importing Mastra: the framework must not be in the runtime graph of
      // anyone who installs this adapter. Mentioning it in an error message or a
      // comment is fine; importing it is not.
      for (const path of artefacts(adapter.dir)) {
        expect(
          importsPkg(path, adapter.frameworkPeer),
          `${path} imports ${adapter.frameworkPeer} — read the agent structurally instead`
        ).toBe(false);
      }
    }
  );

  it.each(ADAPTERS)('$pkg stays small enough to be uninlined', (adapter) => {
    // A blunt backstop for the case the import checks cannot see: if a
    // framework ever *were* inlined, the bundle would balloon. The adapter is a
    // few hundred lines of glue, so tens of KB is the right order of magnitude.
    const bytes = readFileSync(distEntry(adapter.dir)).byteLength;

    expect(
      bytes,
      `${adapter.pkg}'s bundle is ${Math.round(bytes / 1024)}KB — suspiciously large for glue code; is a dependency being inlined?`
    ).toBeLessThan(200_000);
  });
});

const n8nDistBuilt = existsSync(distEntry(N8N_DIR));
/** n8n has TWO entry points, unlike every adapter's one — see tsup.config.ts's own doc comment. */
const n8nArtefacts = () => [
  ...artefacts(N8N_DIR, 'index'),
  ...artefacts(N8N_DIR, 'preload'),
];
/**
 * Only the CJS half of each pair, for the two checks below that need a file
 * to directly `require`/`import(...)` a dependency's name — confirmed by
 * actually inspecting the built output, not assumed: tsup's ESM build for
 * this package (unlike every current adapter's) splits shared code into a
 * separate `chunk-*.js` the top-level `index.js`/`preload.js` import from, so
 * neither ESM entry file directly contains `@dapr/dapr`/`@diagrid/agent-core`
 * as text — only the chunk does. The CJS build has no such split: `index.cjs`
 * and `preload.cjs` each independently, fully contain what they import.
 */
const n8nCjsArtefacts = () => n8nArtefacts().filter((p) => p.endsWith('.cjs'));

/**
 * `@diagrid/n8n`'s own runtime shape — deliberately NOT the adapter
 * invariant above. Two assertions are the OPPOSITE of the adapter ones on
 * purpose: this package SHOULD import `@dapr/dapr` (not inline it — the real,
 * documented divergence from every adapter, see `packages/n8n/README.md`),
 * where an adapter must never import its own framework peer at all.
 */
describe.skipIf(!n8nDistBuilt)(
  'n8n runtime import isolation (not a framework adapter)',
  () => {
    it('imports cleanly in a fresh process and exposes getRuntime', () => {
      // The CJS artifact, not `distEntry`'s default ESM one — a real,
      // previously-undiscovered finding, confirmed by actually running it:
      // `dist/index.js` (ESM) transitively `import`s `n8n-core` as a real
      // value (via `register.ts`), which n8n-core's own `exports["import"]`
      // condition resolves into n8n-workflow's ESM `dist/esm/*` output — whose
      // OWN relative imports (e.g. `from './logger-proxy'`) have no file
      // extension, which Node's ESM resolver (unlike its CJS one) does not
      // tolerate. This is a real defect in n8n's own published ESM build, not
      // this package's; see packages/n8n/README.md's own note on it. `import()`
      // of the CJS artifact (proven below to work, and exactly how n8n's own
      // `--require` consumption resolves this package in practice — n8n's own
      // entry point is plain CJS throughout) sidesteps it entirely.
      const cjsEntry = join(PACKAGES_DIR, N8N_DIR, 'dist', 'index.cjs');
      expect(() => importInFreshProcess(cjsEntry, N8N_RUNNER)).not.toThrow();
    });

    it('imports the shared core rather than inlining it', () => {
      for (const path of n8nCjsArtefacts()) {
        expect(
          importsPkg(path, CORE_PACKAGE_NAME),
          `${path} does not import ${CORE_PACKAGE_NAME} — it looks inlined`
        ).toBe(true);
      }
    });

    it('imports @dapr/dapr rather than inlining it — the deliberate divergence from every adapter', () => {
      for (const path of n8nCjsArtefacts()) {
        expect(
          importsPkg(path, DAPR_PACKAGE_NAME),
          `${path} does not import ${DAPR_PACKAGE_NAME} — it looks inlined ` +
            '(or the dynamic import() in runtime.ts regressed to a static one)'
        ).toBe(true);
      }
    });

    it("never imports any framework adapter's own peer at runtime", () => {
      // Every artefact here, ESM chunk included: unlike the two checks above,
      // asserting ABSENCE doesn't depend on which file happens to contain the
      // real import — a chunk file that doesn't reference @mastra/core is
      // exactly as valid evidence as an entry file that doesn't.
      for (const adapter of ADAPTERS) {
        for (const path of n8nArtefacts()) {
          expect(
            importsPkg(path, adapter.frameworkPeer),
            `${path} imports ${adapter.frameworkPeer} — n8n has no business knowing about a framework adapter`
          ).toBe(false);
        }
      }
    });

    it('stays small enough that neither core nor @dapr/dapr themselves are being inlined', () => {
      // A much higher ceiling than an adapter's: this package's own source
      // (orchestrator, activity, ledger, sub-workflow handling, ...) is
      // legitimately more than "a few hundred lines of glue" — the bar here is
      // "not the size of @dapr/dapr or n8n-core themselves having been bundled
      // in", which would be an order of magnitude larger than this.
      for (const file of ['index.cjs', 'preload.cjs']) {
        const path = join(PACKAGES_DIR, N8N_DIR, 'dist', file);
        if (!existsSync(path)) continue;
        const bytes = readFileSync(path).byteLength;

        expect(
          bytes,
          `${N8N_PKG}'s ${file} is ${Math.round(bytes / 1024)}KB — suspiciously large; is @dapr/dapr or an n8n peer being inlined?`
        ).toBeLessThan(500_000);
      }
    });
  }
);

describe('runtime import isolation (prerequisite)', () => {
  it('reports when the built output is missing', () => {
    // Not an assertion about the code — a signal to whoever reads a local run
    // that a whole layer of this guard was skipped. CI builds first (see
    // deps-check.yaml), so it never skips there.
    if (!allDistsBuilt || !n8nDistBuilt) {
      console.warn(
        '[guard] runtime import isolation skipped: run `pnpm build` first ' +
          '(CI does this in .github/workflows/deps-check.yaml).'
      );
    }
    expect(typeof allDistsBuilt).toBe('boolean');
    expect(typeof n8nDistBuilt).toBe('boolean');
  });
});

// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Guard: file paths named in comments actually exist.
 *
 * Comments in this repo are the design documents — they carry the measured
 * numbers, the rejected alternatives and the reasons an invariant is
 * load-bearing. That earns them a test, because it also makes them the thing
 * most likely to rot silently: moving a file breaks every comment that pointed
 * at it, and nothing in `format`, `lint`, `typecheck` or `test` notices.
 *
 * The rot is not hypothetical. Moving the durable loop into core left
 * `packages/core/src/agent/workflow.ts` introducing itself as the Mastra
 * adapter and pointing at a `./bridge.ts` that does not exist there, a
 * reference to `./workflow.ts` in the mastra bridge after that file was
 * deleted, and a `{@link ../status}` for a sibling module. Three separate
 * comments, all found by a human reading carefully, none by the gate.
 *
 * Deliberately narrow, so it stays trustworthy rather than noisy:
 *
 * - Only relative paths with a real file extension (`./x.ts`, `../y/z.md`) and
 *   `{@link ./x}` targets that look like paths. A bare `{@link ToolInvokers}`
 *   is a symbol, not a path, and is left to the type checker.
 * - Resolution is relative to the file holding the comment, which is what a
 *   reader does.
 * - An extensionless `{@link ./status}` is tried against the TypeScript
 *   extensions, since that is how the source refers to modules.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

const REPO_ROOT = process.cwd();
const ROOTS = ['packages/core/src', 'packages/mastra/src'];
const SOURCE = /\.(ts|mts|cts)$/;

/** A relative path inside a comment: `./x.ts`, `../a/b.md`. */
const PATH_IN_COMMENT =
  /(?:^|[\s(`'"])(\.\.?\/[A-Za-z0-9._/-]+\.[a-z]{2,4})\b/g;
/**
 * A repo-root path: `packages/core/src/agent/workflow.ts`, `.github/...`.
 *
 * The commoner form here, and the one that rots when a package is restructured.
 * Anchored on the known top-level directories so prose like "the agent/workflow
 * split" cannot be mistaken for a path.
 */
const REPO_PATH_IN_COMMENT =
  /(?:^|[\s(`'"])((?:packages|tests|examples|docs|\.github)\/[A-Za-z0-9._/-]+\.[a-z]{2,4})\b/g;
/** A `{@link ./x}` target, which may omit the extension. */
const LINK_TARGET = /\{@link\s+(\.\.?\/[A-Za-z0-9._/-]+)\s*\}/g;

const MODULE_EXTENSIONS = ['', '.ts', '.mts', '.cts', '.d.ts', '/index.ts'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }
    return SOURCE.test(entry) ? [full] : [];
  });
}

/** Comment bodies only — a path in a real `import` is the compiler's problem. */
function comments(source: string): string {
  return (source.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g) ?? []).join('\n');
}

interface Reference {
  readonly file: string;
  readonly target: string;
  readonly resolved: string[];
}

function referencesIn(file: string): Reference[] {
  const body = comments(readFileSync(file, 'utf8'));
  const here = dirname(file);
  const found: Reference[] = [];

  for (const [, target] of body.matchAll(PATH_IN_COMMENT)) {
    if (target === undefined) continue;
    found.push({ file, target, resolved: [resolve(here, target)] });
  }
  for (const [, target] of body.matchAll(REPO_PATH_IN_COMMENT)) {
    if (target === undefined) continue;
    found.push({ file, target, resolved: [resolve(REPO_ROOT, target)] });
  }
  for (const [, target] of body.matchAll(LINK_TARGET)) {
    if (target === undefined) continue;
    found.push({
      file,
      target,
      resolved: MODULE_EXTENSIONS.map((ext) => resolve(here, target + ext)),
    });
  }
  return found;
}

describe('guard: file paths named in comments', () => {
  const all = ROOTS.flatMap(sourceFiles).flatMap(referencesIn);

  it('finds references to check, so a passing run means something', () => {
    // Without this the whole guard reports green if the regexes ever stop
    // matching — the vacuous pass this file exists to prevent elsewhere.
    expect(all.length).toBeGreaterThan(10);
  });

  it('every path a comment names exists on disk', () => {
    const broken = all
      .filter((ref) => !ref.resolved.some((path) => existsSync(path)))
      .map((ref) => `${ref.file}: "${ref.target}"`);

    expect(broken).toEqual([]);
  });
});

// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Guard: the TypeScript in every README must compile.
 *
 * This exists because of a specific failure, and because of the pattern behind
 * it. `AgentWorkflowInput` was declared with `z.infer` instead of `z.input`,
 * which erases the `.default()`s on `messages` and `maxIterations` and makes
 * both fields *required*. Every quickstart in the repo — root README, the
 * mastra README, and the JSDoc example emitted into `dist/index.d.ts` that
 * users see on hover — showed `invoke({ prompt, threadId })`, which then did
 * not compile. Nothing caught it: the examples all passed four fields, so the
 * type checker never saw the two-field call the docs advertised.
 *
 * The examples are workspace members precisely so `tsc` polices them. READMEs
 * are the same public surface with none of the same protection, which is how a
 * documented call signature drifts away from the real one.
 *
 * ## What this deliberately does not check
 *
 * Diagnostics for modules that cannot resolve from this repo are ignored, but
 * *only* for third-party specifiers — `@ai-sdk/openai` appears in the
 * quickstarts and is not a dependency here. An unresolvable `@diagrid/*` import
 * still fails, so a typo or a renamed export in our own surface is caught. The
 * effect is that the AI SDK's types are `any` in these snippets while ours are
 * fully checked, which is the right trade: this guard is about our API.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Opt out of a block that is illustrative rather than runnable. */
const SKIP_MARKER = '<!-- typecheck: skip';

/** The same opt-out, for a JSDoc example where HTML comments make no sense. */
const SOURCE_SKIP_MARKER = 'typecheck: skip';

interface Snippet {
  readonly file: string;
  readonly line: number;
  readonly code: string;
}

/**
 * Published source files whose JSDoc carries a fenced example.
 *
 * These matter as much as the READMEs and are easier to miss: a `@example`
 * block in `runner.ts` is emitted verbatim into `dist/index.d.ts`, so it is what
 * an editor shows on hover. That copy of the quickstart had the same two defects
 * as the README copies — a two-field `invoke()` that did not compile under
 * `z.infer`, and a `new Agent({...})` missing the required `id` — and neither
 * was visible to `tsc`, because a comment is not code.
 */
function sourcePaths(): string[] {
  const dir = join(ROOT, 'packages');
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name, 'src'))
    .filter((src) => existsSync(src))
    .flatMap((src) =>
      readdirSync(src, { withFileTypes: true, recursive: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
        .map((entry) => join(entry.parentPath, entry.name))
    );
}

/** Every README in the repo: root, each package, each example. */
function readmePaths(): string[] {
  const candidates = [join(ROOT, 'README.md')];

  for (const group of ['packages', 'examples']) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) continue;

    candidates.push(join(dir, 'README.md'));
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(join(dir, entry.name, 'README.md'));
      }
    }
  }

  return candidates.filter((path) => existsSync(path));
}

/**
 * Fenced `ts` blocks, with their 1-based line number so a failure is clickable.
 *
 * A block whose fence is preceded by {@link SKIP_MARKER} is dropped. The marker
 * carries its reason inline, so an exemption has to be argued in the README
 * itself rather than hidden in this file.
 */
function extractSnippets(path: string): Snippet[] {
  const isSource = path.endsWith('.ts');
  // In a JSDoc block every line carries a ` * ` gutter, fences included.
  const strip = (line: string) =>
    isSource ? line.replace(/^\s*\*\s?/, '') : line;
  const lines = readFileSync(path, 'utf8').split('\n').map(strip);
  const snippets: Snippet[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^```(ts|typescript)\s*$/.test(lines[index] ?? '')) continue;

    // Look back past blank lines for an opt-out marker. The marker carries its
    // reason, so it is usually a multi-line HTML comment — walk back to `<!--`
    // and test the whole comment, not just the line above the fence.
    let look = index - 1;
    while (look >= 0 && (lines[look] ?? '').trim() === '') look -= 1;

    let skipped = false;
    if (isSource && (lines[look] ?? '').includes(SOURCE_SKIP_MARKER)) {
      skipped = true;
    } else if ((lines[look] ?? '').trimEnd().endsWith('-->')) {
      const commentLines: string[] = [];
      for (let back = look; back >= 0; back -= 1) {
        commentLines.unshift(lines[back] ?? '');
        if ((lines[back] ?? '').trimStart().startsWith('<!--')) break;
      }
      skipped = commentLines.join('\n').includes(SKIP_MARKER);
    }

    const body: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && !/^```\s*$/.test(lines[cursor] ?? '')) {
      body.push(lines[cursor] ?? '');
      cursor += 1;
    }

    if (!skipped) {
      snippets.push({
        file: path.replace(`${ROOT}/`, ''),
        line: index + 1,
        code: body.join('\n'),
      });
    }

    index = cursor;
  }

  return snippets;
}

/** The repo's own compiler options, so a snippet is held to the same bar. */
function compilerOptions(): ts.CompilerOptions {
  const configPath = join(ROOT, 'tsconfig.base.json');
  const { config } = ts.parseConfigFileTextToJson(
    configPath,
    readFileSync(configPath, 'utf8')
  );

  const { options } = ts.convertCompilerOptionsFromJson(
    (config as { compilerOptions?: unknown }).compilerOptions,
    ROOT,
    configPath
  );

  return {
    ...options,
    noEmit: true,
    // Not part of the build graph. Left on, `composite` makes every file the
    // snippet imports an error (TS6307 "not listed within the file list"),
    // because a composite project must enumerate its inputs.
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
    // `paths` in the base config resolve @diagrid/* to source. Keep them
    // anchored at the repo root regardless of where this test runs from.
    pathsBasePath: ROOT,
    types: [],
  };
}

/** Is this a resolution failure for a package we do not ship? */
function isThirdPartyResolution(diagnostic: ts.Diagnostic): boolean {
  if (diagnostic.code !== 2307) return false;

  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
  const specifier = /Cannot find module '([^']+)'/.exec(message)?.[1] ?? '';

  return !specifier.startsWith('@diagrid/');
}

function check(snippet: Snippet): string[] {
  // Inside ROOT so node_modules and `paths` resolve exactly as they would for
  // a real source file. Never written to disk — served from memory below.
  const virtualPath = join(ROOT, `__readme_snippet_${snippet.line}.ts`);
  const options = compilerOptions();
  const host = ts.createCompilerHost(options, true);

  const original = {
    getSourceFile: host.getSourceFile.bind(host),
    fileExists: host.fileExists.bind(host),
    readFile: host.readFile.bind(host),
  };

  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === virtualPath
      ? ts.createSourceFile(fileName, snippet.code, languageVersion, true)
      : original.getSourceFile(fileName, languageVersion, ...rest);
  host.fileExists = (fileName) =>
    fileName === virtualPath || original.fileExists(fileName);
  host.readFile = (fileName) =>
    fileName === virtualPath ? snippet.code : original.readFile(fileName);

  const program = ts.createProgram([virtualPath], options, host);
  const source = program.getSourceFile(virtualPath);

  return [
    ...program.getSyntacticDiagnostics(source),
    ...program.getSemanticDiagnostics(source),
  ]
    .filter((diagnostic) => !isThirdPartyResolution(diagnostic))
    .map((diagnostic) => {
      const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      const offset = diagnostic.start ?? 0;
      const within = snippet.code.slice(0, offset).split('\n').length;
      // Line within the README, so the failure points at the real place.
      return `${snippet.file}:${snippet.line + within} TS${diagnostic.code}: ${text}`;
    });
}

describe('README TypeScript snippets', () => {
  const snippets = [...readmePaths(), ...sourcePaths()].flatMap(
    extractSnippets
  );

  it('finds snippets to check', () => {
    // Without this the suite reports green if the extractor silently breaks or
    // every block acquires a skip marker — the same false-confidence shape as a
    // gated e2e block that skips itself.
    expect(
      snippets.length,
      'no README ts blocks were found — has the extractor or the fence style changed?'
    ).toBeGreaterThanOrEqual(2);
  });

  it.each(snippets.map((s) => ({ id: `${s.file}:${s.line}`, snippet: s })))(
    '$id compiles',
    ({ snippet }) => {
      const errors = check(snippet);

      expect(
        errors,
        `the TypeScript in ${snippet.file} does not compile:\n${errors.join('\n')}`
      ).toEqual([]);
    }
  );
});

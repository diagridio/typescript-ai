// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Stamps a release version across every manifest and `version.ts`.
 *
 * The release workflow reads the version off `main` and refuses to publish
 * unless all seven files already agree, so the bump lands as its own PR. Doing
 * that by hand is the one step with a silent failure mode: miss a file and the
 * mismatch surfaces in CI. This writes all seven and then re-asserts them.
 *
 * Every package moves together even when untouched, because `workspace:*`
 * resolves to an EXACT pin at pack time — @diagrid/agent-mastra@X depends on
 * @diagrid/agent-core@X, so a core bump the others don't follow would leave
 * them pinned to a version that is no longer current, with no way to republish
 * at their old number.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const VERSION = process.argv[2];

if (!VERSION) {
  console.error('usage: pnpm bump <version>   (e.g. pnpm bump 0.2.0)');
  process.exit(1);
}

// Both checks, in the order the release workflow runs them: the character set
// first because it rejects a newline outright, then the semver shape, which the
// character check deliberately does not enforce (it would accept "1.0").
if (/[^0-9A-Za-z.-]/.test(VERSION)) {
  // JSON.stringify so a newline in the value cannot break up the message.
  console.error(
    `error: ${JSON.stringify(VERSION)} contains characters outside [0-9A-Za-z.-]`
  );
  process.exit(1);
}
if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(VERSION)) {
  console.error(
    `error: ${JSON.stringify(VERSION)} is not a valid semver version (e.g. 0.2.0)`
  );
  process.exit(1);
}

const PACKAGES = readdirSync('packages', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const MANIFESTS = [
  'package.json',
  ...PACKAGES.map((p) => `packages/${p}/package.json`),
];
const CONSTANTS = PACKAGES.map((p) => `packages/${p}/src/version.ts`);
const STAMP = (v) => `export const VERSION = '${v}';`;

// Both loops key on whether the pattern MATCHED, not on whether the content
// changed: re-running the same version is a normal operation (a re-dispatch, or
// finishing a half-applied bump) and must not be mistaken for a missing field.
const MANIFEST_VERSION = /("version":\s*")[^"]+(")/;

for (const file of MANIFESTS) {
  const raw = readFileSync(file, 'utf8');
  if (!MANIFEST_VERSION.test(raw))
    throw new Error(`${file}: no version field to replace`);
  // Textual, not JSON.parse/stringify: rewriting the whole manifest would
  // reorder or reformat keys Prettier then fails on.
  writeFileSync(file, raw.replace(MANIFEST_VERSION, `$1${VERSION}$2`));
}

const CONSTANT_VERSION = /^export const VERSION = '.*';$/m;

for (const file of CONSTANTS) {
  const raw = readFileSync(file, 'utf8');
  if (!CONSTANT_VERSION.test(raw))
    throw new Error(`${file}: no VERSION constant to replace`);
  writeFileSync(file, raw.replace(CONSTANT_VERSION, STAMP(VERSION)));
}

// Re-assert exactly what the workflow's "Verify main carries this version"
// step asserts, so a mismatch is caught here rather than after the PR merges.
const failures = [
  ...MANIFESTS.filter(
    (f) => JSON.parse(readFileSync(f, 'utf8')).version !== VERSION
  ),
  ...CONSTANTS.filter((f) => !readFileSync(f, 'utf8').includes(STAMP(VERSION))),
];

if (failures.length > 0) {
  console.error(
    `error: not stamped to ${VERSION}:\n  ${failures.join('\n  ')}`
  );
  process.exit(1);
}

console.log(
  `stamped ${VERSION} across ${MANIFESTS.length + CONSTANTS.length} files:`
);
for (const file of [...MANIFESTS, ...CONSTANTS]) console.log(`  ${file}`);

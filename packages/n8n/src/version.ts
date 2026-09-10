// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Package version.
 *
 * Kept as a source constant (rather than read from `package.json` at runtime)
 * so it survives bundling and works identically from ESM and CJS.
 *
 * `.github/workflows/npm-release.yaml` rewrites this line together with every
 * `package.json` version. It always did: the bump and verify loops glob every
 * package's `version.ts`, so this file was already being stamped before the
 * package had a publish step. What was missing was the publish — the tarball
 * was packed, checked, and discarded. That step exists now.
 *
 * The package still has to be published BY HAND once before the workflow can
 * take over, because npm trusted publishing is configured on a package's own
 * settings page and the package has to exist before OIDC can be pointed at it.
 */
export const VERSION = '0.1.1';

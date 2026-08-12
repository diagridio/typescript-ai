// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Package version.
 *
 * Kept as a source constant (rather than read from `package.json` at runtime)
 * so it survives bundling and works identically from ESM and CJS. The release
 * workflow rewrites this line together with every `package.json` version — see
 * `.github/workflows/npm-release.yaml`.
 */
export const VERSION = '0.1.0';

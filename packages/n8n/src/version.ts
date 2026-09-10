// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Package version.
 *
 * Kept as a source constant (rather than read from `package.json` at runtime)
 * so it survives bundling and works identically from ESM and CJS.
 *
 * TODO(n8n-integration): this package has never been published, so nothing
 * currently stamps this alongside `package.json`'s own version the way
 * `.github/workflows/npm-release.yaml` does for `core`/`mastra`. Wire it into
 * that workflow (or an n8n-specific one) before a real release.
 */
export const VERSION = '0.1.1';

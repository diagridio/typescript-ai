#!/usr/bin/env bash
# Copyright (c) 2026-Present Diagrid Inc.
# SPDX-License-Identifier: BUSL-1.1
#
# Symlinks a local n8n checkout's five packages this package peer-depends on
# directly into packages/n8n/node_modules — see package.json's own
# "//devDependencies" comment for why this can't just be a `file:`
# devDependency: n8n's own packages depend on ~20 further n8n-internal
# packages via `workspace:*`, which only resolves inside n8n's OWN pnpm
# workspace. Pointing a `file:` dependency at them from this workspace makes
# pnpm try (and fail) to resolve those same specifiers here, breaking
# `pnpm install` for the whole repo.
#
# This is what actually needs to exist for BOTH typecheck (TypeScript's own
# module resolution walks node_modules from the importing file, same as
# Node's runtime algorithm — no `paths` mapping needed once these symlinks
# exist) AND for the real end-to-end run (`n8n start` with this package
# `--require`d in resolves `n8n-workflow` etc. via a real n8n install's own
# node_modules; this reproduces the same resolution shape locally against a
# sibling checkout rather than an installed one).
#
# Usage: N8N_CHECKOUT=/path/to/n8n ./scripts/link-n8n-dev-deps.sh
# Defaults to ../../../../n8n relative to this package (a sibling of
# typescript-ai itself) if N8N_CHECKOUT is unset.

set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N8N_CHECKOUT="${N8N_CHECKOUT:-$(cd "$PACKAGE_DIR/../../../../n8n" && pwd)}"

if [ ! -d "$N8N_CHECKOUT/packages/core" ]; then
  echo "error: no n8n checkout found at $N8N_CHECKOUT (expected packages/core there)." >&2
  echo "Set N8N_CHECKOUT=/path/to/n8n and re-run." >&2
  exit 1
fi

mkdir -p "$PACKAGE_DIR/node_modules/@n8n"

link() {
  local target="$1" link_path="$2"
  rm -rf "$link_path"
  ln -s "$target" "$link_path"
  echo "linked $link_path -> $target"
}

link "$N8N_CHECKOUT/packages/core" "$PACKAGE_DIR/node_modules/n8n-core"
link "$N8N_CHECKOUT/packages/workflow" "$PACKAGE_DIR/node_modules/n8n-workflow"
link "$N8N_CHECKOUT/packages/nodes-base" "$PACKAGE_DIR/node_modules/n8n-nodes-base"
link "$N8N_CHECKOUT/packages/@n8n/db" "$PACKAGE_DIR/node_modules/@n8n/db"
link "$N8N_CHECKOUT/packages/@n8n/di" "$PACKAGE_DIR/node_modules/@n8n/di"

echo "Done. Re-run after every \`pnpm install\` — pnpm's isolated nodeLinker" \
     "may prune untracked entries under packages/n8n/node_modules."

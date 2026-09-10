#!/usr/bin/env bash
# Copyright (c) 2026-Present Diagrid Inc.
# SPDX-License-Identifier: BUSL-1.1
#
# Provisions real n8n types for `pnpm typecheck` / `pnpm build` with no live,
# hand-maintained sibling checkout — the read-only, CI-oriented counterpart
# to link-n8n-dev-deps.sh (which is for active development against a
# checkout you already have and keep up to date yourself). Used by every
# workflow that runs `pnpm build` (see .github/actions/provision-n8n-types),
# and safe to run by hand too:
#
#   packages/n8n/scripts/ci-n8n-types.sh [checkout dir]
#
# What it does:
#
#   1. Shallow-fetches the single commit pinned in n8n-ci-ref.txt — bump that
#      file deliberately, not silently; see its own note — into a throwaway
#      checkout dir (default: .n8n-ci-checkout at the repo root; gitignored,
#      meant to be cache-restored by CI keyed on n8n-ci-ref.txt's content,
#      never committed).
#   2. Installs and builds only the workspace closure n8n-core, n8n-workflow,
#      @n8n/db and @n8n/di actually need — computed by asking turbo itself
#      (`--dry=json`), not hand-maintained here, so this stays correct as
#      n8n's own internal dependency graph changes. That closure is n8n's
#      own ~25-package backend-internal cluster (config, errors, decorators,
#      di, its own typeorm fork, ...) — not the ~1000-package full monorepo:
#      no nodes-base, no frontend, no cli. The first `--dry=json` call has to
#      go through `pnpm dlx`, not a plain `pnpm turbo`: nothing is installed
#      yet at that point, so there is no local `turbo` binary to run.
#      n8n-nodes-base itself is never touched here at all: it's a peer
#      dependency of this package but, unlike the other four, is never
#      statically imported (`grep -rn "from 'n8n-nodes-base'" src` to
#      confirm) — the "no nodes-base" clause above falls out of that, not a
#      separate exclusion.
#   3. Symlinks (never copies) those four packages into this package's
#      node_modules, exactly like link-n8n-dev-deps.sh does for a live
#      checkout. This has to be a real symlink: n8n-core's own compiled
#      output resolves its own `n8n-workflow` import through a real,
#      pnpm-created symlink inside the throwaway checkout, so copying
#      n8n-core instead of linking it would carry that inner symlink along
#      and (if dereferenced) turn it into a second, separate copy of
#      n8n-workflow's types — structurally identical to the first but
#      nominally different to TypeScript. That is the exact dual-instance
#      failure package.json's own "//devDependencies" note describes for
#      the rejected real-devDependency approach, produced here by copying
#      instead of linking rather than by pnpm's peer resolution. Uses
#      Node's own fs.symlinkSync with the 'junction' type on win32, not
#      shell `ln -s`: plain `ln -s` via Git Bash on GitHub's hosted Windows
#      runners silently falls back to copying a directory rather than
#      linking it unless Developer Mode and MSYS=winsymlinks:nativestrict
#      are both already set up, which would reintroduce exactly the
#      dual-instance problem above. A directory junction needs neither and
#      resolves identically for Node's/TypeScript's purposes.
#
# Idempotent: if the four targets' dist output already exists in the
# checkout dir (e.g. restored from a CI cache), step 2 is skipped entirely
# and only the symlink step runs — so a cache hit costs one process spawn
# and four symlinks, not a reinstall.

set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N8N_REF="$(grep -oE '[0-9a-f]{40}' "$PACKAGE_DIR/n8n-ci-ref.txt" | head -1)"
N8N_REMOTE="${N8N_REMOTE:-https://github.com/n8n-io/n8n.git}"

mkdir -p "${1:-$PACKAGE_DIR/../../.n8n-ci-checkout}"
CHECKOUT="$(cd "${1:-$PACKAGE_DIR/../../.n8n-ci-checkout}" && pwd)"

DIST_MARKERS=(
  "packages/core/dist/index.d.ts"
  "packages/workflow/dist/esm/index.d.ts"
  "packages/@n8n/db/dist/index.d.ts"
  "packages/@n8n/di/dist/di.d.ts"
)

all_built() {
  local m
  for m in "${DIST_MARKERS[@]}"; do
    [ -f "$CHECKOUT/$m" ] || return 1
  done
}

if all_built; then
  echo "ci-n8n-types: $CHECKOUT already has n8n@$N8N_REF built — skipping fetch/install/build."
else
  if [ "$(git -C "$CHECKOUT" rev-parse HEAD 2>/dev/null || true)" != "$N8N_REF" ]; then
    if [ ! -d "$CHECKOUT/.git" ]; then
      git init -q "$CHECKOUT"
      git -C "$CHECKOUT" remote add origin "$N8N_REMOTE"
    fi
    echo "ci-n8n-types: fetching n8n@$N8N_REF..."
    git -C "$CHECKOUT" fetch --depth 1 origin "$N8N_REF"
    git -C "$CHECKOUT" checkout -q --detach FETCH_HEAD
  fi

  cd "$CHECKOUT"

  # The four packages this package statically imports. `dependsOn: ["^build"]`
  # in n8n's own turbo.json is what pulls each one's real upstream dependency
  # chain in — a bare `--filter=<name>` (no `...`) is what keeps the selection
  # to just that chain: a leading/trailing `...` pulls in *dependents* too
  # (confirmed empirically — it reaches n8n-nodes-base, the frontend and the
  # cli, all of which depend on these four, not the other way round).
  TARGETS=(n8n-core n8n-workflow @n8n/db @n8n/di)
  FILTER_ARGS=()
  for t in "${TARGETS[@]}"; do FILTER_ARGS+=(--filter="$t"); done

  TURBO_VERSION="$(node -p "require('./package.json').devDependencies.turbo" 2>/dev/null || echo latest)"

  echo "ci-n8n-types: computing the real build closure for ${TARGETS[*]}..."
  CLOSURE="$(pnpm dlx "turbo@$TURBO_VERSION" run build "${FILTER_ARGS[@]}" --dry=json 2>/dev/null \
    | sed -n '/^{/,$p' \
    | node -e '
        let d = "";
        process.stdin.on("data", (c) => (d += c));
        process.stdin.on("end", () => {
          const j = JSON.parse(d);
          console.log([...new Set(j.tasks.map((t) => t.package))].join("\n"));
        });
      ')"

  INSTALL_FILTER_ARGS=()
  while IFS= read -r pkg; do
    [ -n "$pkg" ] && INSTALL_FILTER_ARGS+=(--filter="$pkg")
  done <<<"$CLOSURE"

  echo "ci-n8n-types: installing ${#INSTALL_FILTER_ARGS[@]} packages (n8n's own backend-internal closure, not the full monorepo)..."
  pnpm install --frozen-lockfile "${INSTALL_FILTER_ARGS[@]}"

  echo "ci-n8n-types: building..."
  pnpm turbo run build "${FILTER_ARGS[@]}"
fi

mkdir -p "$PACKAGE_DIR/node_modules/@n8n"
node -e '
  const fs = require("fs");
  const path = require("path");
  const [checkout, packageDir] = process.argv.slice(1);
  const pairs = [
    ["packages/core", "n8n-core"],
    ["packages/workflow", "n8n-workflow"],
    ["packages/@n8n/db", "@n8n/db"],
    ["packages/@n8n/di", "@n8n/di"],
  ];
  const type = process.platform === "win32" ? "junction" : "dir";
  for (const [rel, name] of pairs) {
    const target = path.resolve(checkout, rel);
    const linkPath = path.resolve(packageDir, "node_modules", name);
    fs.rmSync(linkPath, { recursive: true, force: true });
    fs.symlinkSync(target, linkPath, type);
    console.log(`linked ${linkPath} -> ${target}`);
  }
' "$CHECKOUT" "$PACKAGE_DIR"

echo "ci-n8n-types: done."

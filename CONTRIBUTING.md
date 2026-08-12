# Contributing

## Prerequisites

- **Node.js ≥ 22.13** — Node 20 is end-of-life (2026-04-30) and `@mastra/core`
  requires ≥ 22.13. `.nvmrc` pins the version CI uses.
- **pnpm 11** — the repo declares `packageManager`, so
  [Corepack](https://nodejs.org/api/corepack.html) will fetch the right version:
  `corepack enable pnpm`.
- **Docker** (daemon running) — only for the integration and e2e lanes.
- **[Dapr CLI](https://docs.dapr.io/getting-started/install-dapr-cli/)** — only
  for the integration and e2e lanes. `dapr init` after installing.

## Setup

```bash
git clone git@github.com:diagridio/typescript-ai.git
cd typescript-ai
pnpm install
make hooks-install   # pre-commit formatting + the full pre-push gate
```

No build step is needed to develop: `tsconfig.base.json` and `vitest.config.ts`
both resolve `@diagrid/agent-*` to source. The published packages point at
`dist/`.

## Everyday commands

Both `make <target>` and `pnpm <script>` work; the Makefile exists to match the
sibling repos and just delegates.

| What                        | Command                   |
| --------------------------- | ------------------------- |
| Unit tests (the PR gate)    | `make test` / `pnpm test` |
| Unit tests with coverage    | `make test-cov`           |
| Watch mode                  | `pnpm test:watch`         |
| Integration tests           | `make test-integration`   |
| Just the CI guard tests     | `make test-guards`        |
| Format (write)              | `make format`             |
| Format check (what CI runs) | `make format-check`       |
| Lint                        | `make lint`               |
| Type check                  | `make typecheck`          |
| Build both packages         | `make build`              |
| Everything CI runs          | `make ci`                 |

## The `integration` split

Mirroring `pytest -m "not integration"` in `diagridio/python-ai`, the marker
here is a **filename suffix** and the two lanes are separate Vitest projects:

- `tests/**/*.test.ts` → the `unit` project. No sidecar, no network, no
  secrets. This is what PRs gate on.
- `tests/**/*.integration.test.ts` → the `integration` project. Live Dapr
  sidecar and/or a real model. Nightly and on demand only.

```bash
pnpm test              # unit only
pnpm test:integration  # integration only
```

A file suffix rather than a tag is deliberate: it is greppable, it cannot be
applied to half a file by accident, and it lets the two lanes differ in timeout
and concurrency.

### Running the Ollama e2e suite locally

```bash
ollama serve &
ollama pull qwen3:0.6b
dapr init

OLLAMA_ENDPOINT=http://localhost:11434/v1 OLLAMA_MODEL=qwen3:0.6b \
  pnpm test:integration
```

Without `OLLAMA_ENDPOINT` the suite skips. Set `DIAGRID_E2E_REQUIRED=1` to turn
a missing prerequisite into a failure instead — that is what CI does, so absent
infrastructure can never green a gated run.

## Test layout

`tests/` mirrors the source tree (`tests/core/…`, `tests/mastra/…`), matching
python-ai. Shared fixtures live in `tests/fixtures/`.

Fixtures are **structurally shaped plain objects**, not real framework
instances. That is not a shortcut: constructing a real Mastra `Agent` in the unit
suite would import `@mastra/core` and mask the exact coupling the guard tests
exist to prevent.

## Running the examples

`examples/mastra/` holds runnable scripts. They are pnpm workspace members, so
the root `pnpm install` covers them and `pnpm typecheck` type-checks them — an
example that stops compiling is the earliest signal the adapter's public API has
drifted.

```bash
pnpm --filter @diagrid/example-mastra run inspect   # no API key, no sidecar
```

`tests/e2e/mastra-examples.integration.test.ts` executes all of them in the
integration lane, so they cannot rot at runtime either. See
[`examples/mastra/README.md`](examples/mastra/README.md) for what each script
does and which currently complete.

## The guard tests

`tests/guards/` holds two invariants that CI runs as their own steps in
[`deps-check.yaml`](.github/workflows/deps-check.yaml), separately from the
general sweep:

- **`cross-framework-imports.test.ts`** — adapter isolation. The `ADAPTERS`
  table must match `packages/` on disk; an adapter's runtime dependencies must
  be nothing but `@diagrid/agent-core`; its framework SDK must be a peer; and
  the built bundle must not have inlined either. A Dependabot bump or a careless
  import that would drag one framework into another's install fails here in
  seconds instead of 20 minutes later in the e2e lane.
- **`telemetry-compat.test.ts`** — the OpenTelemetry contract. Endpoint
  resolution precedence, the no-op-when-unset guarantee, and the upstream
  `@opentelemetry/*` exports that `setupTelemetry` loads behind a dynamic
  `import()`. Those imports are invisible to the type-checker on the disabled
  path, so this is the only thing between a renamed export and a crash the first
  time someone enables tracing in production.

Run `pnpm build` before `make test-guards` locally — the isolation guard
inspects built bundles and skips that layer (loudly) when `dist/` is absent. CI
always builds first.

## Git hooks

`make hooks-install` installs both:

- **pre-commit** — `lint-staged`: Prettier and ESLint `--fix` on staged files
  only. Fast.
- **pre-push** — the full gate: format check, lint, type check, build, unit
  tests. Same commands CI runs, so a push that passes locally passes CI.

`git push --no-verify` skips it when you need to.

## Adding a framework adapter

See [the README](README.md#adding-another-framework). Short version: one new
`packages/<framework>/` following `packages/mastra`'s module layout, one entry in
`SupportedFrameworks`, one entry in the `ADAPTERS` guard table, one Dependabot
block, one publish step.

## Code conventions

- **SPDX headers.** Every source file starts with:
  ```ts
  // Copyright (c) 2026-Present Diagrid Inc.
  // SPDX-License-Identifier: BUSL-1.1
  ```
- **Zod at boundaries.** Anything crossing the workflow boundary or coming out
  of the state store is parsed, not trusted — on replay those values arrive from
  storage, i.e. from outside the process.
- **`TODO(mastra-adapter):`** for unfinished adapter work, so
  `grep -rn 'TODO(mastra-adapter)'` is an accurate work list. Unimplemented
  paths must throw or report an error, never return a plausible-looking result.
- **Peer, not hard, dependencies** for framework SDKs. The guard enforces it.

## Commit messages

Conventional commits: `<type>: <description>` where type is one of `feat`,
`fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

## Releasing

Publishing is manual and deliberate: run the
[**Release npm Packages**](.github/workflows/npm-release.yaml) workflow with a
version. It stamps every `package.json` and `version.ts`, re-locks, runs the full
gate, commits, tags `v$VERSION`, cuts a GitHub release, and publishes
`@diagrid/agent-core` before `@diagrid/agent-mastra`.

Use the `dry_run` input first — it does everything except commit, tag, release
and publish, and uploads the tarballs so you can inspect exactly what would
ship.

npm credentials are **not** configured yet; the workflow header lists what an
npm org admin has to set up (trusted publishing, or an `NPM_TOKEN` secret).

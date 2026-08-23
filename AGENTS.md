# AGENTS.md

Working notes for an AI assistant in this repo: the things that are easy to get
wrong. The README says what the project is; this does not repeat it.

**Verified 2026-08-23.** Every `diagrid` claim below was checked against CLI
**v1.66.0** (API server 1.93.0), logged in to production. An older CLI answers
differently about project flags and component names, so run `diagrid version`
before trusting a local `--help`.

## `main` is empty — the content is unmerged

- `origin/main` is a single commit, `chore: initialize repository`, whose tree is
  `4b825dc642cb6eb9a060e54bf8d69288fbee4904` — the git empty tree. **Zero
  files.** A checkout of `main` gives you nothing to work with.
- Everything real lives on **`feat/scaffold-mastra-adapter`**, open as **PR #3**
  and waiting on a human reviewer. That branch is the authoritative tree; treat
  it as `main` until it merges.
- **Branch off `feat/scaffold-mastra-adapter` and open PRs against it.** A PR
  targeting `main` renders the whole repository as its diff and is unreviewable.
  `fix/managed-component-names` (**PR #8**) is already stacked that way.
- Do not merge, rebase or force-push #3 or #8 — they are somebody else's review
  queue, and moving #8's base destroys its diff.
- `main` _is_ branch-protected: one approving review, stale reviews dismissed,
  admins included, force-push and deletion blocked. But there are **no required
  status checks**, so a green tick is not a gate — read the checks yourself.
- The repository is **private**. Anything written here must stand alone: it
  cannot assume `diagridio/catalyst-ai` (also private) is readable.

## The workspace

pnpm workspace, `nodeLinker: isolated`, members `packages/*` and `examples/*`.

| Path              | What                                                                      |
| ----------------- | ------------------------------------------------------------------------- |
| `packages/core`   | `@diagrid/agent-core` — the durable agent loop. Published.                |
| `packages/mastra` | `@diagrid/agent-mastra` — the Mastra adapter. Published.                  |
| `examples/mastra` | Private, but a workspace member so `tsc` polices the public API.          |
| `tests/`          | **Not** a workspace member — no `package.json`; runs off the root config. |

- **Mastra is the only framework integration**, and the first of an intended set.
  `SupportedFrameworks` in `packages/core/src/types/frameworks.ts` is the list;
  `tests/guards/cross-framework-imports.test.ts` fails until a new adapter is
  registered there, which is the point.
- **`nodeLinker: isolated` means a dependency of `packages/core` does not resolve
  from `tests/`.** That is why `@dapr/dapr`, `@grpc/grpc-js`, `@opentelemetry/*`
  and `@mastra/core` appear _again_ as root `devDependencies` — the guards import
  them directly. It looks like duplication and is not; the root `package.json`
  carries a `"//devDependencies"` note explaining it. Do not de-duplicate.
- **pnpm blocks install scripts** unless named under `allowBuilds` in
  `pnpm-workspace.yaml` (`esbuild` and `protobufjs` only). A new dependency with
  a postinstall is silently inert until it is listed.
- Node ≥ 22.13 (`.nvmrc` pins 22.13.0); pnpm 11.21.0 via `packageManager`, so
  `corepack enable pnpm` rather than a global install.

## Build, test, gate

- **No build is needed to develop.** `tsconfig.base.json` `paths` and
  `vitest.config.ts` `alias` both resolve `@diagrid/agent-*` to source.
- **The guards are the exception — they read `dist/`.** `dist-smoke`,
  `cross-framework-imports` and `telemetry-compat` inspect built bundles and run
  the real `exports` resolution. Run `pnpm build` first, or `make test-guards`,
  which builds for you. Without `dist/` the isolation guard skips that layer and
  still reports green.
- **`pnpm test` runs the `unit` project only.** The integration lane is selected
  by the **filename suffix** `.integration.test.ts` — not a tag, not a
  `describe` marker — via `pnpm test:integration`.
- **The setup file is unit-only, deliberately.** `tests/setup.unit.ts` deletes
  `OTEL_*` and `DAPR_*` around every test; the integration project has no setup
  file, because those variables are its configuration. Do not promote it to a
  shared setup.
- `make ci` is `format:check`, `lint`, `typecheck`, `build`, `test:unit` — the
  same five commands in the same order as `.husky/pre-push` and `build.yaml`, so
  a clean push is a clean PR.
- `prettier --check .` covers Markdown and YAML too, at `printWidth` 80. A
  hand-aligned table fails the gate; run `pnpm format`.

### Six workflows, and which of them run on a stacked PR

| Workflow           | Runs on                                              |
| ------------------ | ---------------------------------------------------- |
| `build.yaml`       | every PR (no branch filter), push to `main`          |
| `deps-check.yaml`  | every PR (no branch filter), push to `main`          |
| `security.yaml`    | every PR, push to `main`, weekly Mon 06:00 UTC       |
| `e2e-ollama.yaml`  | **PRs into `main` only**, nightly 04:00 UTC          |
| `integration.yaml` | nightly 03:00 UTC and `workflow_dispatch` — never PR |
| `npm-release.yaml` | `workflow_dispatch`, and refused off `main`          |

- **A PR stacked on `feat/scaffold-mastra-adapter` gets no e2e lane.**
  `e2e-ollama.yaml` still carries `pull_request: branches: [main]`, the filter #7
  removed from `build.yaml` and `deps-check.yaml` but not from this one. Observed
  directly: PR #3 (base `main`) ran `e2e-ollama`; PR #8 (base the feature branch)
  did not. It is the only lane that drives a real agent turn through a real
  sidecar, and the bug class it exists to catch — a workflow reported COMPLETED
  without running a single activity — is invisible to the unit suite, which
  drives the orchestrator directly and so bypasses Dapr's dispatch entirely.
  Dispatch it by hand, or run the Ollama suite locally, before calling a runtime
  change green.
- `codeql` reporting **`skipping`** is correct, not a failure: it is gated on
  `github.event.repository.private == false` because code scanning needs Advanced
  Security. It switches itself on when the repo goes public.
- Before #7, `build.yaml` filtered on `feature/*` and `release-*` while every
  branch here is named `feat/*`, so PRs #4 and #5 merged with **zero** CI and
  nothing in the PR UI said so. Do not reintroduce a branch allow-list.

## `workspace:*`, and the publish path

`@diagrid/agent-mastra` depends on `@diagrid/agent-core` as `workspace:*`. That
specifier means nothing to a consumer, and how it gets resolved decides whether
the published package installs at all.

- **Pack with pnpm; publish with npm.** Both halves verified by running them:
  - `pnpm pack` rewrites the dependency to the exact concrete version —
    `"@diagrid/agent-core": "0.1.1"`.
  - `npm pack` in the same directory ships `workspace:*` **verbatim** as the
    dependency range — unresolvable, and unfixable afterwards, because npm
    versions are immutable.
  - `npm publish` is used only because it is the one of the two that implements
    `--provenance`; it accepts the pnpm-built tarball, so both properties can be
    had at once.
- `npm-release.yaml` does exactly this and then greps every tarball for
  `"workspace:` before publishing. Never work around it with a local publish.
- Publish order is **core, then mastra** — mastra pins core's exact version, so
  the reverse order publishes a package whose dependency does not exist yet.
- The version lives in **five** places: the root manifest (private, but kept in
  step so the repo has one version number), both package manifests, and both
  `src/version.ts` constants — source, so the value survives bundling. The
  release workflow stamps all five and then verifies them.
- The workflow requires `github.ref == 'refs/heads/main'` and pushes its bump
  commit to `main`, so **no release can happen until #3 merges.**

### npm state today, and what `--access public` does

- `@diagrid/agent-core@0.1.0` and `@diagrid/agent-mastra@0.1.0` **exist and are
  private**: `npm access get status` reports `private` for both, and an
  unauthenticated `GET https://registry.npmjs.org/@diagrid%2Fagent-core` is a 404.
- They were published **by hand from a laptop**, to make the packages exist at
  all — a trusted publisher can only be added on a package's own settings page.
  The consequence is visible on the registry: `dist` for 0.1.0 carries the
  registry signature and **no `attestations`**. Provenance requires the publish
  to run in GitHub Actions; a laptop cannot produce one.
- Both manifests set `publishConfig: { access: "public", provenance: true }`, and
  `npm-release.yaml` additionally hardcodes `--provenance --access public` on
  both publish steps. So **the first release from `main` flips the scope from
  private to public** — 0.1.1 onward is world-readable. That is a decision, not
  a detail.
- The branch declares **0.1.1**, not 0.1.0, because npm versions are immutable
  and the workflow's own pre-flight refuses a version already on the registry.
- The workflow is built for **npm OIDC trusted publishing**: `id-token: write`,
  Node **24** (npm ≥ 11.5.1 is required and Node 22 ships npm 10.9.8, which
  cannot do it), and `NODE_AUTH_TOKEN` left commented out. Whether the trusted
  publisher is actually registered on npmjs.com is **not readable from the CLI**;
  the observable proof will be a provenance attestation appearing on 0.1.1.
- **Never publish to npm from a working session.** Use the workflow, `dry_run`
  first.

## Catalyst

- `diagrid dev run -a <id> -- <cmd>` injects `DAPR_GRPC_ENDPOINT` +
  `DAPR_API_TOKEN`; local `dapr run` sets `DAPR_GRPC_PORT`. `sidecar.ts` accepts
  either — do not reduce it to one. Use `-a/--id`: `--app-id` is deprecated at
  v1.66.0 and gone from `--help` (works, warns), so add no new uses.
- The **server** names managed components, not the CLI: `--deploy-managed-kv` →
  **`kvstore`**, `--deploy-managed-pubsub` → **`pubsub`**. Confirmed live in
  three projects; these are the SDK defaults.
- `agent-memory`/`-pubsub`/`-registry`/`-runtime`/`-workflow` are real but come
  from the agent-infrastructure path, not those flags. Assume neither set exists
  — `diagrid component list --project <p>`. This repo's own `typescript-ai-dev`
  has `agent-*` and **no** `kvstore`/`pubsub`.
- `--enable-agent-infrastructure` is **not on `project create`** at all; on
  `project update` it is for BYOC/private-region projects or cloud projects
  without managed KV. Never print it as setup guidance.
- `diagrid agent` fronts your own app — what an SDK app under `dev run` uses.
  `managed-agent` is a Catalyst-hosted Durable Agent, hidden and employee-only:
  keep it out of this repo. Deeper platform notes live in the (private)
  `diagridio/catalyst-ai` plugin — a pointer, never a dependency.

## Conventions

- Two-line BUSL header at the top of every `.ts` file:
  `Copyright (c) 2026-Present Diagrid Inc.` then
  `SPDX-License-Identifier: BUSL-1.1`.
- **Zod at boundaries.** Anything crossing the workflow boundary, or read back
  out of the state store, is parsed rather than trusted — on replay those values
  arrive from storage, which is outside the process.
- Framework SDKs are **peer** dependencies, never runtime ones. An adapter's only
  runtime dependency is `@diagrid/agent-core`, and the isolation guard enforces
  both halves.
- Activities may be non-deterministic; the orchestrator may not. No clock, no
  randomness and no I/O in orchestrator code — Dapr replays it.
- `TODO(mastra-adapter):` marks unfinished adapter work, so
  `grep -rn 'TODO(mastra-adapter)'` is an accurate work list. An unimplemented
  path throws or reports an error; it never returns a plausible-looking result.
- Conventional-commit subjects, and `git commit -s` — sign-off is the norm across
  this history.
- **Never commit `dev-*.yaml`.** `diagrid dev scaffold` bakes a live
  `DAPR_API_TOKEN` into it. `.gitignore` covers the pattern; do not add an
  exception for it.

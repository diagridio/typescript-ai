# @diagrid/n8n

Durable execution of [n8n](https://n8n.io) workflow node runs on
[Dapr Workflows](https://docs.dapr.io/developing-applications/building-blocks/workflow/).

Attaches to a stock n8n process at load time
(`NODE_OPTIONS="--require @diagrid/n8n/register" n8n start`) — no upstream n8n
changes, no fork. Each n8n node run becomes a durable Dapr activity, guarded by
an idempotency ledger, so a multi-node workflow survives a process crash and
resumes from its last completed node, with no duplicate side effects.

## Why not `SupportedFrameworks` / `BaseAgentMapper`

Every other package in this repo (`packages/mastra`, and every adapter planned
alongside it) wraps an **LLM agent framework** — `SupportedFrameworks` in
`@diagrid/agent-core` and `BaseAgentMapper` both model that specifically. An n8n
workflow is a general-purpose automation graph, not an agent in that sense, so
this package deliberately does **not** add an `N8N` entry to
`SupportedFrameworks` and does not implement `BaseAgentMapper` —
`tests/guards/cross-framework-imports.test.ts` covers this package under its
own, separate assertions rather than the adapter ones for exactly this reason.

`BaseWorkflowRunner` (`packages/core/src/workflow/runner.ts`) can't be
subclassed either way — its constructor requires a `SupportedFramework` value
from that same closed union. `runtime.ts` borrows its _patterns_ directly
instead of inheriting them: lazy, idempotent construction (a memoized
construction promise, not a static import — `@dapr/dapr` is dynamically
`import()`-ed, exactly like `dapr.ts`/`status.ts` do in core, and for the same
reason: a static import would make a bare `require()` of this package eagerly
load ~136 `@dapr/dapr` modules and ~65 from `@grpc/grpc-js` before any n8n code
ever runs — this package is `--require`d into every boot, so that cost is even
more directly paid here than for an adapter that's merely `import`ed once), a
`shutdown()` that attempts every cleanup step independently and collects
failures into an `AggregateError` rather than letting one throw strand the
rest, and the same opt-in `registerShutdownHandlers()` SIGINT/SIGTERM pattern.

**Real, plainly-stated consequence:** since this package doesn't go through
`BaseWorkflowRunner`, it needs `@dapr/dapr` as its own **direct** runtime
dependency — unlike every other adapter here, whose only runtime dependency is
`@diagrid/agent-core`. `runtime.ts` is the only file in this package that
imports `@dapr/dapr` as a _value_; every other file only needs
`WorkflowContext`/`WorkflowActivityContext` as **types**, reused from
`@diagrid/agent-core`'s own type-only re-export (`workflow/dapr.ts`), which
keeps the divergence as narrow as it can be while still being real.

Reused from `@diagrid/agent-core` rather than duplicated:

- `workflow/status.ts`'s `WorkflowRuntimeStatus`/`workflowStatusName` — a
  numeric enum declared locally in core (not re-exported from `@dapr/dapr`, for
  the same static-import reason above). Comparing a `runtimeStatus` to a string
  literal is silently always false; this removes that whole risk class.
- `state/store.ts`'s `DaprStateStore` — backs the idempotency ledger
  (`ledger.ts`) instead of raw `DaprClient` usage. Its default component name,
  `kvstore`, is adopted as-is: it's the real, live Catalyst-managed component
  name, so an n8n deployment on Catalyst needs no extra configuration. Override
  with `DIAGRID_N8N_STATE_STORE`.
- `workflow/dapr.ts`'s type-only re-exports (`WorkflowContext`,
  `WorkflowActivityContext`, `WorkflowRuntime`, `DaprWorkflowClient`, …) — used
  everywhere except `runtime.ts`.

## `@dapr/dapr` version: 3.18.0, the workspace-pinned published version

Verified against the real, installed 3.18.0 — not assumed, and not the local,
unreleased SDK checkout the original standalone package was first built
against. Every part of the API surface this package depends on matches:
`registerWorkflowWithName`/`registerActivityWithName`, `WorkflowContext`'s
`callActivity`/`whenAll`/`whenAny`/`createTimer`/`waitForExternalEvent`/
`callChildWorkflow`, `DaprWorkflowClient`'s
`scheduleNewWorkflow`/`waitForWorkflowCompletion`/`getWorkflowState`/
`raiseEvent`, and `WorkflowRuntimeStatus`'s exact numeric values (confirmed
identical to what `@diagrid/agent-core`'s own `status.ts` declares — RUNNING 0,
COMPLETED 1, CONTINUED_AS_NEW 2, FAILED 3, TERMINATED 5, PENDING 6, SUSPENDED 7) — including the exact same deterministic child-workflow instance-id
derivation formula (`` `${parentInstanceId}:${seq.toString(16).padStart(4,'0')}` ``,
confirmed directly in `runtime-orchestration-context.js`'s
`callSubOrchestrator`) the sub-workflow crash-recovery proof depends on.

Two known upstream findings from the original package's own Phase 0, each
re-checked against 3.18.0's real source rather than re-asserted:

- **The hardcoded-concurrency-ceiling silent work-item drop is fixed.**
  `task-hub-grpc-worker.js` still caps in-flight work at 10
  (`_maxConcurrentWorkItems`), but a work item beyond that ceiling now queues
  (up to `_maxQueueSize = 100`, logged at `debug`) instead of being silently
  dropped — it's only dropped, with a `warn` log, once that 100-item queue
  itself is full.
- **The unbounded `scheduleNewWorkflow` gRPC call is still present.**
  `client.js`'s `scheduleNewOrchestration` calls
  `promisify(this._stub.startInstance...)` with no deadline or call options —
  confirmed by reading the file directly; there is no timeout anywhere in the
  call chain. `run-durably.ts`'s own `SCHEDULE_TIMEOUT_MS`/`withTimeout` guard
  is therefore still necessary and is kept unchanged.

## Install

```bash
pnpm add @diagrid/n8n
```

`n8n-core`, `n8n-workflow`, `n8n-nodes-base`, `@n8n/db`, and `@n8n/di` are
**peer** dependencies (marked `optional: true` in `peerDependenciesMeta` — see
the `//peerDependenciesMeta` note in `package.json` for exactly why that's a
pnpm-install-time workaround, not a claim this package works without them): a
real n8n install already provides all five at the versions it was built
against; this package must never bundle or pin its own copies.

## Usage

```bash
NODE_OPTIONS="--require @diagrid/n8n/register" n8n start
```

That's the entire integration surface — no code changes to any workflow, no
n8n configuration. Point the process at a reachable Dapr sidecar the normal
way (`DAPR_HOST`/`DAPR_GRPC_PORT`, or Catalyst's `DAPR_GRPC_ENDPOINT`/
`DAPR_API_TOKEN`), and every subsequent manual workflow execution runs as a
durable Dapr orchestration instead of an in-memory one.

### Developing against a local n8n checkout

Two sibling checkouts (this repo and an n8n checkout) have no `node_modules`
path from one to the other, so local development needs two extra steps `pnpm
add` alone doesn't cover:

```bash
# Symlink n8n's own packages into this package's node_modules — see the
# script's own doc comment for why this can't be a plain `file:` dependency.
N8N_CHECKOUT=/path/to/n8n packages/n8n/scripts/link-n8n-dev-deps.sh

# --require by absolute path, since the bare `@diagrid/n8n/register` specifier
# has no node_modules entry to resolve through in this shape:
NODE_OPTIONS="--require /absolute/path/to/packages/n8n/dist/preload.cjs" \
  node /path/to/n8n/packages/cli/bin/n8n start
```

**The absolute path must point at `dist/preload.cjs`, not `dist/preload.js`.**
This package declares `"type": "module"` (unlike the original standalone
package it was ported from, which had no dual build), so `dist/preload.js` is
the real ESM output. `--require`ing it _by absolute path_ bypasses this
package's own `exports` map — the thing that would otherwise route a real
`--require "@diagrid/n8n/register"` to the correct build for a CJS caller — so
Node's newer synchronous `require(esm)` support loads it as genuine ESM
instead, which cascades into the real, more serious defect described next.
Confirmed by reproducing it directly: not a bug in this package's real-world
`--require` usage — n8n's own entry point (`bin/n8n`) is plain CJS throughout,
so the only path a genuine install ever takes is `require()` through the
`exports` map's `"require"` condition, landing correctly on `dist/preload.cjs`
every time. It only bites a sibling-checkout absolute-path `--require`, which
is why this section calls it out explicitly.

### A real one, not just a dev-path quirk: `import`-ing this package's ESM build never works

Unlike the `.cjs`-vs-`.js` mix-up above, this one isn't specific to a
sibling-checkout `--require` — it reproduces from the _documented_, correctly
`exports`-map-routed path too: a genuine `import { register } from
'@diagrid/n8n'` from someone else's ESM code, or `node --input-type=module -e
"await import('@diagrid/n8n')"`, both fail the same way. `index.ts` re-exports
`register.ts`, which does `import { WorkflowExecute } from 'n8n-core';` as a
real value — under `dist/index.js` (the ESM build), that resolves `n8n-core`
through _its own_ `exports["import"]` condition into n8n-workflow's ESM
`dist/esm/*` output, whose own relative imports (e.g. `from
'./logger-proxy'`) have no file extension — invalid under Node's ESM resolver
(unlike its CJS one), so it throws `ERR_MODULE_NOT_FOUND`. This is a real
defect in n8n's own published ESM build, not something this package can fix.
`tests/guards/cross-framework-imports.test.ts`'s n8n-specific "imports
cleanly" check therefore runs against `dist/index.cjs` rather than the default
ESM entry every other package's equivalent check uses — see that test's own
comment. **Practical consequence:** anything that needs to consume this
package programmatically (not just `--require`) should do so via `require()`
or a bundler targeting CJS, not a native ESM `import`, until n8n's own
published ESM output fixes its extensionless relative imports.

## Module layout

| File                                     | Role                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `preload.ts`                             | What `--require @diagrid/n8n/register` actually loads: patches n8n, starts the runtime eagerly             |
| `register.ts`                            | The actual monkeypatch — `WorkflowExecute.prototype.processRunExecutionData`                               |
| `runtime.ts`                             | Owns the Dapr `WorkflowRuntime`/`DaprWorkflowClient` lifecycle — see "Why not `SupportedFrameworks`" above |
| `run-durably.ts`                         | Schedules one Dapr orchestration per n8n execution and waits for it, replacing the patched method          |
| `orchestrator.ts` / `orchestrator-v2.ts` | The deterministic replay loop — see "Versioning discipline" below for why there are two                    |
| `activity.ts`                            | The one generic activity every node type dispatches through — the only place real side effects happen      |
| `execute-node.ts`                        | Builds the narrowest possible n8n execution context to call a node's real `execute()`                      |
| `ledger.ts`                              | Idempotency ledger for activity results, backed by `@diagrid/agent-core`'s `DaprStateStore`                |
| `sub-workflow.ts`                        | Resolves and dispatches an Execute Workflow node as a real Dapr child workflow                             |
| `execution-status-sync.ts`               | Writes the orchestration's final outcome into n8n's own execution record, as a dispatched activity         |
| `execution-progress.ts`                  | Syncs each node's outcome into n8n's execution record incrementally, as it happens                         |
| `round-log.ts`                           | orchestrator-v2's one real behavioral addition — see "Versioning discipline"                               |
| `task-data.ts`                           | Maps a finished node's result to n8n's own per-node `ITaskData` shape                                      |
| `schemas.ts`                             | Zod schemas for everything crossing the workflow boundary — see "Zod at boundaries" below                  |
| `types.ts` / `constants.ts`              | Shared types and versioned Dapr workflow/activity names                                                    |
| `version.ts`                             | Version marker                                                                                             |

## Versioning discipline

Every orchestrator/activity name is registered explicitly under a versioned
name (`constants.ts`), never left to default inference — the design this
package inherited already recommended it, and this port is the first time it
was actually built _and proven_, not just asserted.

`orchestrator-v2.ts` is a deliberate, near-total duplicate of `orchestrator.ts`
(v1), forked at the point both versions share. Duplicating the whole file,
rather than sharing the body through a parameterized helper, is intentional:
it's the most literal way to guarantee v1's registered function is genuinely
byte-for-byte unmodified, which is the entire point of the proof — the Dapr JS
SDK resolves which registered generator function handles a given orchestration
by looking up the name persisted in that instance's own `ExecutionStarted`
history event, on **every single replay**, against whichever process is
currently connected. `runtime.ts` registers **both** names unconditionally, in
the same running process — the way a real rolling deploy, or an in-place
upgrade of a single-worker deployment, actually looks. `run-durably.ts`
schedules every new top-level execution against v2; v1 stays registered purely
to keep draining whatever already committed to it. The one real (not
cosmetic) difference in v2 is `round-log.ts`: a new activity dispatched at the
start of every dispatch round, which changes the yield sequence — exactly what
makes replaying a v1 instance under v2's code a genuine mismatch, and
registering both names side by side the actual fix.

## Idempotency and at-least-once activities

Dapr guarantees each activity runs **at least once**. `activity.ts` is the
only place a real n8n node's `execute()` runs, and it's guarded by
`ledger.ts`: a redelivery of the exact same attempt (same instance, node, run
index, and attempt number) reads back the already-recorded result instead of
calling `execute()` again. A genuinely new attempt — after a real failure and
its durable backoff wait — gets a new attempt number and does run for real.

This is the mechanism the crash-recovery proof depends on: a process killed
while an activity is genuinely in flight leaves no ledger entry (the activity
never returned), so a redelivery to the next connected process runs the node's
real side effect exactly once. A process killed _after_ an activity returned
but crashed before Dapr durably recorded that completion would, in principle,
redeliver into a real second execution of that one node's side effect — the
same narrow, structural at-least-once window every Dapr Workflow-backed system
has. This package narrows it to per-node granularity; it does not close it.

## Zod at boundaries

Real, previously-missing rigor closed in this port, not just noted as a gap:
`schemas.ts` gives every activity input/output, the top-level
`OrchestrationInput` (the first thing replayed from an instance's own history
on every single replay), and every ledger read a real Zod schema, parsed
rather than trusted via a bare cast. Deliberately proportionate, not
exhaustive: n8n's own `INode`/`IConnections`/`INodeExecutionData` are large,
evolving types owned by n8n, not this package — `nodeShapeSchema`/
`nodeExecutionDataSchema` validate the handful of fields this package actually
reads, with `.passthrough()` for the rest, rather than re-deriving n8n's whole
type system and drifting from it on every n8n upgrade.

## Scope — real, honest gaps, not silent omissions

`grep -rn 'TODO(n8n-integration)' src` lists every one of these with its exact
location. Every gap below was already true of the original standalone package
this was ported from; none is new:

- **Credentials are unimplemented.** Only credential-free node types are
  wired up (`Set`, `NoOp`, `If`, `Merge`, `Wait`) — enough to prove branching,
  retry, and durable waits without needing credential resolution, which is
  real, separate work (`execute-node.ts`).
- **n8n's real webhook HTTP endpoint doesn't call `raiseEvent` yet.**
  External-event Wait-node resume is proven only via a direct
  `DaprWorkflowClient.raiseEvent` call, not through n8n's own webhook routing
  (`packages/cli`'s `waiting-webhooks.ts`/`live-webhooks.ts`) — untouched by
  this package (`constants.ts`).
- **Sub-workflow children have no execution-list row of their own** — they run
  as real, durable Dapr child workflows, but don't appear as a separate entry
  in n8n's UI (`types.ts`).
- **The sub-workflow node has no retry loop** of its own — a failed resolve or
  a failed child is recorded as that node's error on the first attempt, not
  retried by the orchestrator's backoff logic (`orchestrator.ts`).
- **Only "select workflow by id" is supported** for the Execute Workflow node,
  with a literal id only — no expressions, no parameter/JSON, local-file, or
  URL source modes (`sub-workflow.ts`).
- **The incremental execution-list sync's concurrency guard is
  single-process-only.** A queue-mode/multi-worker n8n deployment remains
  untested — nothing reachable through `@n8n/db` offers a real
  compare-and-swap on the column being written (`execution-progress.ts`).
- **Cancellation is not implemented.** The real `processRunExecutionData`
  returns a `PCancelable<IRun>`; this returns a plain `Promise`, so the
  editor's "stop execution" button does not work yet (`run-durably.ts`,
  `register.ts`).
- **This package has never been published** — nothing currently stamps
  `version.ts` alongside `package.json`'s own version the way
  `.github/workflows/npm-release.yaml` does for `core`/`mastra` (`version.ts`).
- **`pnpm typecheck` needs a linked sibling n8n checkout to pass.** Without
  one (a from-scratch clone, CI included), `tsc` fails with `Cannot find
module 'n8n-core'` and similar for every file that imports one of this
  package's five optional peers — confirmed by actually removing
  `scripts/link-n8n-dev-deps.sh`'s symlinks and clearing `.tsbuild`. Two real
  fixes were investigated and both reverted, not just skipped (see
  `package.json`'s own `//devDependencies` note for the full account): an
  ambient shorthand module declaration (`declare module 'n8n-workflow';`,
  falling back to `any`) conflicted with the real types whenever both were
  present in the same compilation (`TS2709: Cannot use namespace '...' as a
type`); real, pinned
  npm devDependencies for the four statically-imported peers resolved but
  then hit pnpm installing n8n-core's and `@n8n/db`'s own copies of
  `n8n-workflow` as two structurally distinct, non-interchangeable peer-hashed
  instances (n8n's packages are built to be installed inside n8n's own
  cohesive workspace, not as independent top-level devDependencies elsewhere)
  — real `INode`/`ITaskData`/etc. "not assignable" errors with no actual bug
  behind them. This package can only be meaningfully type-checked (and, as
  the whole rest of this README documents, only meaningfully _run_) against a
  real, linked n8n checkout — the same requirement the original standalone
  package it was ported from already had.

## License

[Business Source License 1.1](../../LICENSE.md) — © 2026–Present Diagrid Inc.

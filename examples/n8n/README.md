# n8n examples

Durable n8n workflow node runs on Dapr Workflows, using
[`@diagrid/n8n`](../../packages/n8n/README.md).

## Status

Verified end to end against a real Dapr sidecar and a real, locally-built n8n
process (`n8n-core`/`n8n-workflow`/`n8n-nodes-base` linked from a sibling
checkout — see [`packages/n8n/README.md`](../../packages/n8n/README.md#developing-against-a-local-n8n-checkout)).

| Script              | What it proves                                                                 | Needs a sidecar | Needs n8n running       |
| ------------------- | ------------------------------------------------------------------------------ | --------------- | ----------------------- |
| `crash-recovery.ts` | a mid-execution kill resumes the workflow, with no duplicate side effects      | yes             | yes, separately started |
| `regression.ts`     | branching/merge, sub-workflows, and node retry still work on the current build | yes             | yes, separately started |

Unlike `examples/mastra/`, these scripts cannot start, crash, or restart n8n
themselves — `@diagrid/n8n` attaches to n8n as a **separate server process**
via `NODE_OPTIONS`, not as a library this example constructs and calls
in-process. What each script automates is everything either side of that
external, shell-level step: creating fixture workflows (idempotent),
triggering them via n8n's real REST API, and verifying the real evidence once
they complete.

## Setup

n8n itself isn't part of this workspace — you need a real, separately-built
n8n checkout, and Docker (for `dapr init`'s Redis) — see
[`packages/n8n/README.md`](../../packages/n8n/README.md#developing-against-a-local-n8n-checkout)
for linking one in. From the repo root:

```bash
pnpm install
pnpm build
```

## Two ways to run

### Local Dapr (self-hosted)

Components come from [`resources/statestore.yaml`](resources/statestore.yaml) —
two components (`workflows-state`, the actor state store the workflow engine
claims; `kvstore`, the idempotency ledger), both backed by the Redis
`dapr init` provisions.

```bash
dapr init   # once; needs Docker

# terminal 1 — a genuinely long-lived placeholder command; n8n runs as its
# OWN separate process (terminal 2), not as the "app" dapr run launches, so a
# killed-and-restarted n8n can find the same sidecar again.
dapr run --app-id diagrid-example-n8n --resources-path ./resources \
  --dapr-http-port 3610 --dapr-grpc-port 50310 -- sh -c 'while true; do sleep 3600; done'

# terminal 2 — n8n, patched, pointed at that sidecar
DAPR_HTTP_PORT=3610 DAPR_GRPC_PORT=50310 \
NODE_OPTIONS="--require /absolute/path/to/packages/n8n/dist/preload.cjs" \
  node /absolute/path/to/n8n/packages/cli/bin/n8n start

# terminal 3 — the example scripts
pnpm crash-recovery
pnpm regression
```

### Diagrid Catalyst (managed)

Components live in the Catalyst project — no `--resources-path`:

```bash
diagrid login
diagrid project create typescript-ai-dev \
  --deploy-managed-kv --deploy-managed-pubsub --enable-managed-workflow \
  --wait --use --ignore-if-exists

# terminal 1
diagrid dev run --app-id diagrid-example-n8n -- sh -c 'while true; do sleep 3600; done'

# terminal 2 — same n8n command as above, but sourced from `diagrid dev run`'s
# own env instead of the local DAPR_HTTP_PORT/DAPR_GRPC_PORT pair (it sets
# DAPR_GRPC_ENDPOINT/DAPR_API_TOKEN instead — @dapr/dapr reads either shape)
```

Both paths use the same component names, so the scripts adapt automatically —
`sidecar.ts` reports which one it detected the same way `examples/mastra`'s
does.

## The scripts

### `crash-recovery.ts` — surviving a dead n8n process

Run it, then follow the printed instructions: kill the n8n process (SIGKILL),
confirm the wait is durable, restart it the same way, and run the script
again to verify.

```bash
pnpm crash-recovery   # first call: creates + triggers the fixture workflow
#  ... kill and restart n8n, per the script's own printed instructions ...
pnpm crash-recovery   # second call: verifies it resumed and completed
```

The fixture is a `Manual Trigger → Wait (90s, timeInterval) → NoOp` workflow —
comfortably over `Wait.node.ts`'s own 65-second durable-timer threshold, so
the wait is a genuine Dapr durable timer (`ctx.createTimer`), not the
in-process `setTimeout` fallback below that threshold. That gives an operator
a wide, unhurried window to do the actual kill-and-restart by hand, unlike a
node-level artificial delay, which needs a precisely-timed kill (see
`regression.ts` below for that shape instead).

### `regression.ts` — a quick pass on everything else this package supports

Exercises what `crash-recovery.ts` alone doesn't: branching/merge (a
`Manual Trigger → {Set, Set} → Merge` fan-out/fan-in), a sub-workflow (a
parent's `Execute Workflow` node dispatching a child as a real Dapr child
workflow), and node retry (a test-only flaky node, wired in via
`DIAGRID_N8N_TEST_NODE_TYPES_MODULE` — see
[`fixtures/flaky-node.cjs`](fixtures/flaky-node.cjs)). Each fixture is created
idempotently and triggered fresh on every run; the script polls each
execution to completion and reports pass/fail against the real execution
record.

```bash
# n8n must be started with the flaky-node fixture wired in for the retry case:
DIAGRID_N8N_TEST_NODE_TYPES_MODULE=/absolute/path/to/examples/n8n/fixtures/flaky-node.cjs \
DIAGRID_N8N_FLAKY_COUNTER_FILE=/tmp/diagrid-n8n-flaky-counter \
  NODE_OPTIONS="--require /absolute/path/to/packages/n8n/dist/preload.cjs" \
  node /absolute/path/to/n8n/packages/cli/bin/n8n start

pnpm regression
```

Without the flaky-node fixture wired in, `regression.ts` still runs the
branching and sub-workflow checks and reports the retry check as skipped
rather than failing — it's real, additional coverage, not a hard requirement
to exercise the rest.

## Dapr components

| Component         | Role                                           | Local (`resources/`) | Catalyst        |
| ----------------- | ---------------------------------------------- | -------------------- | --------------- |
| `workflows-state` | Dapr workflow engine state (actor state store) | `state.redis`        | `state.diagrid` |
| `kvstore`         | `@diagrid/n8n`'s idempotency ledger            | `state.redis`        | `state.diagrid` |

Two local components rather than one, because Dapr permits only one actor
state store per app, and that role belongs to `workflows-state` — the ledger
does plain key/value work against `kvstore`, `@diagrid/agent-core`'s
`DaprStateStore` default (`DEFAULT_STORE_NAME`), reused as-is by
`packages/n8n/src/ledger.ts` rather than the original standalone package's own
`statestore` default — see `packages/n8n/README.md`'s "Why not
`SupportedFrameworks`" section. `DIAGRID_N8N_STATE_STORE` overrides the
ledger's component name without a code change, the same way `DIAGRID_STATE_STORE`
does for the mastra examples.

## Shared module

`sidecar.ts` is reused, unmodified in shape, from `examples/mastra/sidecar.ts`
— the same two-path detection (`DAPR_GRPC_ENDPOINT` for Catalyst,
`DAPR_GRPC_PORT` for local `dapr run`) applies unchanged. `n8n-client.ts` holds
the small REST client both `crash-recovery.ts` and `regression.ts` share:
owner setup/login, workflow create-or-reuse, trigger, and execution polling —
kept in one place so the two scripts don't duplicate n8n's own cookie-session
plumbing.

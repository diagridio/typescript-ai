# Mastra examples

Durable [Mastra](https://mastra.ai) agents on Dapr Workflows, using
[`@diagrid/agent-mastra`](../../packages/mastra/README.md).

## Status

The adapter's model and tool bridges are still `TODO(mastra-adapter)` stubs, so
only one of these scripts completes today. The others are written against the
finished API and fail explicitly: without a sidecar they tell you the `dapr run`
command to use, and under a sidecar they fail at the first model call with a
"not implemented" message. They are the acceptance criteria for that work, not
decoration.

| Script              | Runs today?             | Needs a sidecar | Needs an API key |
| ------------------- | ----------------------- | --------------- | ---------------- |
| `inspect-agent.ts`  | ✅ yes                  | no (optional)   | no               |
| `simple-agent.ts`   | ❌ model bridge missing | yes             | yes¹             |
| `crash-recovery.ts` | ❌ model bridge missing | yes             | yes¹             |
| `retry.ts`          | ❌ model bridge missing | yes             | yes¹             |

¹ Unless you set `OLLAMA_ENDPOINT`, in which case a local model is used and no
key is needed.

`tests/e2e/mastra-examples.integration.test.ts` executes all four in CI. It
verifies `inspect-agent.ts`'s output field by field, and verifies the other three
fail with an actionable message — no gRPC stack traces, and never a claim of
success.

## Two ways to run

Every script works on both paths. They differ only in where Dapr components come
from, and the scripts adapt automatically — they report which path they detected.

### Local Dapr (self-hosted)

Components come from the on-disk [`resources/`](resources/) directory.

```bash
dapr init                       # once; needs Docker, and gives you Redis on :6379
dapr run --app-id mastra-inspect --resources-path ./resources -- pnpm inspect
```

### Diagrid Catalyst (managed)

Components live in the Catalyst project, so there is **no** `--resources-path`.

```bash
diagrid login
diagrid project create typescript-ai-dev \
  --enable-agent-infrastructure \
  --use --ignore-if-exists      # provisions pubsub, KV store, workflow, registry

# Creates the App ID if it does not exist, and needs no file on disk
diagrid dev run --app-id mastra-inspect -- pnpm inspect
```

`diagrid dev run` injects `DAPR_GRPC_ENDPOINT` (remote, TLS) and
`DAPR_API_TOKEN`; `@dapr/dapr` reads both from the environment, so the adapter
needs no Catalyst-specific code.

**Nothing else to configure.** `--enable-agent-infrastructure` provisions
components named `agent-memory`, `agent-pubsub`, `agent-runtime` and
`agent-workflow` — and the first two are already the adapter's defaults
(`DEFAULT_STORE_NAME` / `DEFAULT_PUBSUB_NAME` in `@diagrid/agent-core`). Confirm
with:

```bash
diagrid component list --project <project>
```

That single command is the recommended path. It is also the only one that keeps
credentials off disk — see the warning below.

<details>
<summary>Multi-app runs with a scaffolded dev file</summary>

For running several examples at once, `diagrid dev scaffold` generates a
multi-app run file. Two things to know:

**It needs an App ID to exist first**, otherwise it generates a file with nothing
to run:

```bash
diagrid appid create mastra-inspect --project typescript-ai-dev
diagrid dev scaffold -f dev-mastra.yaml
```

**The generated file needs editing.** Scaffold assumes each app lives in its own
subdirectory and does not know how to start yours, so it emits
`appDirPath: ./<app-id>` and no `command`. For these examples:

```yaml
apps:
  - appID: mastra-inspect
    appDirPath: ./ # not ./mastra-inspect
    command: ['pnpm', 'inspect'] # scaffold leaves this out
    # ...leave the generated env block as-is
```

Then:

```bash
diagrid dev run -f dev-mastra.yaml --dry-run   # see what it would create
diagrid dev run -f dev-mastra.yaml
```

> **⚠️ The generated file contains a live credential.** Scaffold bakes a
> `DAPR_API_TOKEN` (`diagrid://v1/<org>/<project>/<appid>/<secret>`) into the env
> block. `dev-*.yaml` is therefore gitignored in this repo — never commit one, and
> be careful pasting one into an issue or a chat. `diagrid dev run --app-id …`
> avoids the problem entirely by keeping the token in the session.

</details>

## Setup

```bash
pnpm install          # from the repo root
export OPENAI_API_KEY=sk-...
```

To use a local model instead of OpenAI:

```bash
ollama serve &
ollama pull qwen3:0.6b
export OLLAMA_ENDPOINT=http://localhost:11434/v1
export OLLAMA_MODEL=qwen3:0.6b   # optional, this is the default
```

Or point at any other model with `DIAGRID_EXAMPLE_MODEL='anthropic/claude-sonnet-4-5'`.

## The scripts

### `inspect-agent.ts` — what Diagrid publishes about your agent

Prints the canonical workflow name and the full registry record: framework,
resolved model and provider, and every tool with its JSON Schema. That record is
what a Catalyst project renders, so this is the fastest way to check an agent is
configured the way you think.

```bash
pnpm inspect
```

Needs nothing — no key, no sidecar. Run it under a sidecar and it additionally
starts the workflow runtime, proving the workflow and activities register:

```bash
dapr run --app-id mastra-inspect --resources-path ./resources -- pnpm inspect
# or
diagrid dev run --app-id mastra-inspect -- pnpm inspect
```

### `simple-agent.ts` — one durable agent turn

Every model call and tool execution is a checkpointed activity, so killing the
process mid-turn and restarting resumes from the last completed activity instead
of re-running the turn.

```bash
dapr run --app-id mastra-simple --resources-path ./resources -- pnpm simple
# or
diagrid dev run --app-id mastra-simple -- pnpm simple
```

### `crash-recovery.ts` — surviving a dead process

Run it twice. The first run hard-kills the process partway through the second
tool call; the second run lets Dapr resume the same workflow. A state file under
`$TMPDIR` proves the first tool was **not** re-executed — its result was replayed
from workflow history.

```bash
rm -f "${TMPDIR:-/tmp}/diagrid-mastra-crash-state.json"

# Local Dapr — run twice
dapr run --app-id mastra-crash --resources-path ./resources -- pnpm crash-recovery
dapr run --app-id mastra-crash --resources-path ./resources -- pnpm crash-recovery

# or Catalyst — run twice
diagrid dev run --app-id mastra-crash -- pnpm crash-recovery
diagrid dev run --app-id mastra-crash -- pnpm crash-recovery
```

### `retry.ts` — a flaky tool retried in place

A tool that fails its first two attempts. Dapr retries the _activity_: the agent
loop does not restart and the model is not re-invoked, so you don't pay for
earlier LLM calls again.

```bash
dapr run --app-id mastra-retry --resources-path ./resources -- pnpm retry
# or
diagrid dev run --app-id mastra-retry -- pnpm retry
```

## Dapr components

Both paths use the same component names, so switching between them changes
nothing:

| Component        | Role                                      | Local (`resources/`) | Catalyst         |
| ---------------- | ----------------------------------------- | -------------------- | ---------------- |
| `agent-workflow` | workflow engine state (actor state store) | `state.redis`        | `state.diagrid`  |
| `agent-memory`   | conversation memory / checkpoints         | `state.redis`        | `state.diagrid`  |
| `agent-pubsub`   | agent lifecycle events                    | not used yet         | `pubsub.diagrid` |

**Local Dapr** reads [`resources/statestore.yaml`](resources/statestore.yaml),
which declares the first two. They are separate components because Dapr permits
only one actor state store, and that role belongs to `agent-workflow`.

**Catalyst** provisions all of them via `--enable-agent-infrastructure`; that path
ignores `resources/` entirely.

If your project uses different names, `DIAGRID_STATE_STORE` overrides the memory
store without a code edit. Swap in your own state store for anything real — any
Dapr state component with actor support works.

## Shared modules

`model.ts`, `tools.ts`, `sidecar.ts` and `store.ts` hold the model resolution, the
three demo tools, the sidecar detection and the state-store selection, so each
script can keep its interesting part — the agent config and the runner usage —
front and centre.

`sidecar.ts` exists for two reasons. Starting the workflow runtime with no sidecar
otherwise fails deep inside gRPC with `ECONNREFUSED 127.0.0.1:50001`, which reads
like a broken install rather than a missing `dapr run`. And the two run paths
advertise themselves differently — local Dapr sets `DAPR_GRPC_PORT`, Catalyst sets
`DAPR_GRPC_ENDPOINT` — so a check for either one alone rejects a valid run.

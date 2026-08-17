# @diagrid/agent-mastra

Durable execution of [Mastra](https://mastra.ai) agents on
[Dapr Workflows](https://docs.dapr.io/developing-applications/building-blocks/workflow/).

The agent's control loop is modelled as a Dapr Workflow and each model call and
tool execution as a durable activity, so an agent survives process crashes,
sidecar restarts and provider outages without re-running work it already
completed.

## Status

Working, and verified by running it rather than by inspection — against a local
`dapr run` sidecar and against Diagrid Catalyst, with Ollama (`qwen2.5:7b`) as the
model.

| Area                                       | State                                                                |
| ------------------------------------------ | -------------------------------------------------------------------- |
| Runner lifecycle and workflow naming       | ✅                                                                   |
| Durable agent loop (`agentWorkflow`)       | ✅ model call → tool activities → repeat                             |
| Model bridge                               | ✅ one step per iteration via `clientTools`                          |
| Tool bridge                                | ✅ one checkpointed activity per tool call                           |
| Crash recovery                             | ✅ tool ran exactly once across a mid-turn kill                      |
| Activity retry (model and tool)            | ✅ in-orchestrator, 3 attempts with durable backoff                  |
| Registry metadata (`getMetadata()`)        | ⚠️ the record is correct, but nothing publishes it — see below       |
| Checkpoint persistence                     | ⚠️ implemented and tested, but the runner never calls it — see below |
| Native Dapr activity `RetryPolicy`         | ❌ not in the JS SDK; the orchestrator retries instead               |
| Component discovery for registry metadata  | ❌ `TODO(mastra-adapter)`                                            |
| Tools needing `RequestContext` / workspace | ❌ `TODO(mastra-adapter)`                                            |

### The two ⚠️ rows

Both are built and unit-tested but have no caller — a working part is not the
same thing as a working feature:

- **Checkpoint persistence.** `DaprMastraCheckpointer.save()/load()/list()` have
  no callers outside their tests. The runner constructs one and exposes it as a
  public field; nothing writes to it, so `load()` always returns `undefined` in
  practice. Continuing a thread today means passing prior `messages` into
  `invoke()` yourself.
- **Registry metadata.** `getMetadata()` returns a correct record — the examples
  print it — but nothing publishes it to a state store or agent registry. Note it
  reports `memory.shortTerm = { type: 'DaprMastraCheckpointer' }`, which is
  accurate about intent and ahead of the wiring.

`grep -rn 'TODO(mastra-adapter)' src` lists what is left. `tests/e2e/` runs the
examples under a real sidecar in CI, so these claims stay honest.

## Install

```bash
pnpm add @diagrid/agent-mastra @mastra/core
```

`@mastra/core` and `zod` are **peer** dependencies: your application owns their
versions, and installing this adapter never pulls another framework's SDK into
your tree.

- Node.js ≥ 22.13
- `@mastra/core` ≥ 1.50 < 2
- `zod` ^4

## Usage

```ts
import { Agent } from '@mastra/core/agent';
import { openai } from '@ai-sdk/openai';
import { DaprWorkflowAgentRunner } from '@diagrid/agent-mastra';

const agent = new Agent({
  id: 'support-agent',
  name: 'support-agent',
  instructions: 'You help customers with billing questions.',
  model: openai('gpt-4o-mini'),
});

const runner = new DaprWorkflowAgentRunner({
  agent,
  name: 'support-agent',
  maxIterations: 10,
});

// Shut down cleanly on SIGINT/SIGTERM (opt-in: a library must not install
// process-wide handlers behind your back).
const disposeHandlers = runner.registerShutdownHandlers();

await runner.start();

const result = await runner.invoke({
  prompt: 'Why was I charged twice?',
  threadId: 'thread-123',
});

console.log(result.text, result.status, result.iterations);

disposeHandlers();
await runner.shutdown();
```

Prefer `runner.schedule(...)` when the caller should not block — an agent turn
outliving an HTTP request is the normal case, not the exception. It returns the
workflow instance id, which you can poll with `runner.getWorkflowStatus(id)`.

## Module layout

The same shape every adapter in this repo follows:

| File          | Role                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| `runner.ts`   | Public entrypoint — `DaprWorkflowAgentRunner`, lifecycle and invocation |
| `workflow.ts` | The Dapr workflow (durable agent loop) and its activities               |
| `models.ts`   | Zod schemas for everything crossing the workflow boundary               |
| `state.ts`    | `DaprMastraCheckpointer` — conversation memory in a Dapr state store    |
| `mapper.ts`   | `MastraAgentMapper` — the `BaseAgentMapper` implementation              |
| `version.ts`  | Version marker, stamped by the release workflow                         |

## Notes on metadata extraction

`MastraAgentMapper` reads a Mastra `Agent` **structurally** rather than
importing `@mastra/core`. That is deliberate: importing the framework here would
put it in the runtime graph of anyone installing the adapter, which
`tests/guards/cross-framework-imports.test.ts` forbids.

Four consequences worth knowing:

- **Config is read through the class accessors**, not the plain properties. A
  real `Agent` keeps `instructions` and `tools` private and exposes them via
  `getInstructions()` and `listTools()`; reading `agent.tools` returns
  `undefined`. `listTools()` is async, which is why
  `mapper.mapAgentMetadata()` and `runner.getMetadata()` are async too.
- **All three of Mastra's model forms are supported**: the model-router magic
  string (`'openai/gpt-4o-mini'`), an OpenAI-compatible config
  (`{ id, url }` or `{ providerId, modelId, url }` — how you point at Ollama),
  and an AI SDK model instance. A malformed router id is echoed back verbatim so
  the typo is visible in the registry, rather than collapsed to `unknown`.
- Mastra also accepts `instructions`, `model` and `tools` as a **factory**. A
  factory needs a `RuntimeContext` that does not exist at registration time, so
  dynamic config is **skipped** — the registry shows the static configuration. It
  does not guess.
- Tool argument schemas are rendered as JSON Schema via Zod 4's
  `z.toJSONSchema()`. Zod 3 schemas and schemas containing transforms are not
  representable, and degrade to an empty string rather than to
  `[object Object]`.

See [`examples/mastra/`](../../examples/mastra/README.md) — `pnpm inspect` prints
the whole record for a real agent.

## License

[Business Source License 1.1](../../LICENSE.md) — © 2026–Present Diagrid Inc.

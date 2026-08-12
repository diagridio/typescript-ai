# @diagrid/agent-mastra

Durable execution of [Mastra](https://mastra.ai) agents on
[Dapr Workflows](https://docs.dapr.io/developing-applications/building-blocks/workflow/).

The agent's control loop is modelled as a Dapr Workflow and each model call and
tool execution as a durable activity, so an agent survives process crashes,
sidecar restarts and provider outages without re-running work it already
completed.

## Status

**Scaffold.** This package compiles, is unit-tested, and its public API is
settled — but the two bridges into Mastra are typed stubs. Concretely:

| Area                                              | State                                            |
| ------------------------------------------------- | ------------------------------------------------ |
| Runner lifecycle (`start`/`shutdown`/signals)     | ✅ implemented                                   |
| Canonical workflow naming                         | ✅ implemented, matches the Python SDK           |
| Registry metadata (`MastraAgentMapper`)           | ✅ implemented (static config; see notes below)  |
| Zod I/O models for the workflow boundary          | ✅ implemented                                   |
| Checkpoint persistence (`DaprMastraCheckpointer`) | ✅ implemented                                   |
| Durable agent loop (`agentWorkflow`)              | ✅ implemented and unit-tested                   |
| **Model bridge** (`invokeModel` → Mastra's model) | ❌ `TODO(mastra-adapter)` — throws               |
| **Tool bridge** (`invokeTool` → Mastra's tools)   | ❌ `TODO(mastra-adapter)` — reports unknown tool |

Unimplemented paths throw or report an error rather than returning a
plausible-looking result, so nothing here can be mistaken for a working
integration. `grep -rn 'TODO(mastra-adapter)' src` lists everything outstanding.

## Install

```bash
pnpm add @diagrid/agent-mastra @mastra/core
```

`@mastra/core` and `zod` are **peer** dependencies: your application owns their
versions, and installing this adapter never pulls another framework's SDK into
your tree.

- Node.js ≥ 22.13
- `@mastra/core` ≥ 1.50 < 2
- `zod` ^3.25 or ^4

## Usage

```ts
import { Agent } from '@mastra/core/agent';
import { openai } from '@ai-sdk/openai';
import { DaprWorkflowAgentRunner } from '@diagrid/agent-mastra';

const agent = new Agent({
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

Two consequences worth knowing:

- Mastra accepts `instructions`, `model` and `tools` as either a value or a
  (possibly async) factory. A factory needs a `RuntimeContext` that does not
  exist at registration time, so dynamic config is **skipped** — the registry
  shows the static configuration. It does not guess.
- Tool argument schemas are rendered as JSON Schema via Zod 4's
  `z.toJSONSchema()`. Zod 3 schemas and schemas containing transforms are not
  representable, and degrade to an empty string rather than to
  `[object Object]`.

## License

[Business Source License 1.1](../../LICENSE.md) — © 2026–Present Diagrid Inc.

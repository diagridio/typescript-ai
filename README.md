# Durable Workflows for TypeScript AI agents

**Make your AI agents resilient to failure and outages**

`@diagrid/agent-*` is a set of extension packages for the open-source
[Dapr](https://github.com/dapr/dapr) project that make TypeScript AI agents
durable and fault-tolerant. Each adapter wraps an agent framework in a Dapr
Workflow so agents recover from crashes, persist state across restarts, and
survive provider outages without re-running (and re-paying for) work they had
already completed.

This is the TypeScript sibling of
[`diagridio/python-ai`](https://github.com/diagridio/python-ai),
[`diagridio/dotnet-ai`](https://github.com/diagridio/dotnet-ai),
[`diagridio/go-ai`](https://github.com/diagridio/go-ai) and
[`diagridio/java-ai`](https://github.com/diagridio/java-ai).

Get started with [Diagrid Catalyst for free](https://diagrid.ws/get-catalyst).

> ### Status: working, not yet published
>
> The [Mastra](https://mastra.ai) adapter runs real agent turns as Dapr
> Workflows, verified end to end against both a local sidecar and Diagrid
> Catalyst: tool calls execute as separate checkpointed activities, and a process
> killed mid-turn resumes without recomputing completed work. Nothing is
> published to npm yet — see
> [`packages/mastra/README.md`](packages/mastra/README.md) for the detail.

## Community

Have questions, hit a bug, or want to share what you're building? Join the
[Diagrid Community Discord](https://diagrid.ws/diagrid-community) to connect
with the team and other users.

## Features

- **Durability:** Agent state is persisted in the database of your choice. If
  the process crashes, the agent resumes from the last completed step rather
  than restarting the turn.
- **Fault tolerance:** Built-in retries and error handling powered by Dapr.
- **Observability:** OpenTelemetry traces across agent execution, tool calls and
  state transitions — a no-op until you point it at a collector.
- **Framework-agnostic core:** One shared runtime, one small adapter per
  framework. [Mastra](https://mastra.ai) is the first.

## Installation

Install the shared runtime plus the adapter for your framework:

```bash
# For Mastra
pnpm add @diagrid/agent-mastra @mastra/core
```

`@diagrid/agent-core` comes in as a dependency of the adapter; you only need to
install it directly if you are writing an adapter of your own. The framework
SDK (`@mastra/core`) is a **peer dependency**, so your application controls its
version and installing one adapter never pulls in another framework.

## Prerequisites

- **Node.js:** 22.13 or newer (Node 20 is end-of-life; `@mastra/core` requires
  ≥ 22.13)
- **Dapr:** a Dapr sidecar, either self-hosted (`dapr init`, needs Docker) or
  managed via [Diagrid Catalyst](https://diagrid.ws/get-catalyst)
- **A state store component** for agent memory (Redis, CosmosDB, Postgres, …)

## Quickstart

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

const runner = new DaprWorkflowAgentRunner({ agent, name: 'support-agent' });
await runner.start();

// One durable agent turn. Every model call and tool call is a checkpointed
// activity, so killing this process mid-turn and starting it again resumes
// instead of restarting.
const result = await runner.invoke({
  prompt: 'Why was I charged twice?',
  threadId: 'thread-123',
});

console.log(result.text);
await runner.shutdown();
```

Run it under a sidecar — either self-hosted Dapr or managed Catalyst:

```bash
# Local Dapr: components come from ./resources
dapr run --app-id support-agent --resources-path ./resources -- node dist/agent.js

# Diagrid Catalyst: components come from the Catalyst project
diagrid dev run --app-id support-agent -- node dist/agent.js
```

> Expect two iterations: one model call requesting tools, then another turning
> their results into an answer. Each step is a separate checkpointed activity, so
> killing the process mid-turn and restarting resumes rather than re-running.

## How it works

The adapter leverages
[Dapr Workflows](https://docs.dapr.io/developing-applications/building-blocks/workflow/)
to orchestrate agent execution:

1. **Orchestration** — the agent's control loop becomes a workflow, registered
   under the canonical name `dapr.<framework>.<AgentName>.workflow` (identical
   to the scheme the Python, Go, .NET and Java SDKs use, so one Catalyst project
   can host agents in any of them).
2. **Activities** — every LLM call and every tool execution becomes a durable
   activity. Activities may be non-deterministic; the orchestrator may not.
3. **State store** — Dapr saves workflow state after every activity, which is
   what lets a killed process resume mid-turn. Carrying a thread _across_ turns
   is not wired up yet: `DaprMastraCheckpointer` exists but nothing calls it, so
   continuing a conversation today means passing the prior `messages` into
   `invoke()` yourself. See the status table in
   [`packages/mastra/README.md`](./packages/mastra/README.md).

Your code runs anywhere — laptop, Kubernetes, EC2 — while the workflow engine
owns the agent's execution state.

## Repository layout

```text
packages/core      @diagrid/agent-core    shared runtime: the durable agent
                                          loop, base runner, agent mapper
                                          contract, workflow naming, state,
                                          checkpointer, pub/sub, telemetry
packages/mastra    @diagrid/agent-mastra  the Mastra adapter
examples/mastra                           runnable scripts, type-checked in CI
tests/             mirrors the source tree; `tests/guards/` holds the two
                   invariants CI enforces directly
```

Start with [`examples/mastra/`](examples/mastra/) — `pnpm inspect` there needs no
API key and no sidecar, and prints exactly what Diagrid publishes about an agent.

## Adding another framework

The repository is laid out so a second framework is a small, well-bounded
change. Everything framework-specific lives in one package:

1. `mkdir packages/<framework>` and copy `packages/mastra`'s shape, which is
   deliberately small: `bridge.ts` (drive the framework one step at a time),
   `mapper.ts` (`BaseAgentMapper` implementation), `runner.ts` (public
   entrypoint, mostly wiring), `state.ts` (a `DaprAgentCheckpointer` subclass
   supplying the key prefix), `version.ts`, `index.ts`, `README.md`.

   You do **not** write the durable agent loop. The orchestrator, its
   activities, the retry behaviour and every Zod schema that crosses the
   workflow boundary live in `@diagrid/agent-core` (`src/agent/`), because none
   of them mention a framework. Only `bridge.ts` and `mapper.ts` are genuinely
   framework-specific.

2. Add the framework to `SupportedFrameworks` in
   `packages/core/src/types/frameworks.ts`.
3. Add an entry to `ADAPTERS` in
   `tests/guards/cross-framework-imports.test.ts` — that guard fails until you
   do, which is the point.
4. Add a `package-ecosystem: npm` block for the new directory in
   `.github/dependabot.yml`, and a publish step in
   `.github/workflows/npm-release.yaml`.
5. Add an `examples/<framework>/` directory. Examples are workspace members and
   are type-checked, so they keep the adapter's public API honest — the build
   breaks the moment it drifts.

The framework SDK must be a **peer** dependency, never a hard one — the
isolation guard enforces it.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
pnpm install
make test        # unit tests
make lint        # eslint
make typecheck   # tsc --build
make hooks-install
```

## License

[Business Source License 1.1](LICENSE.md) — © 2026–Present Diagrid Inc.
Converts to Apache 2.0 on the Change Date. Production use is permitted under
the Additional Use Grant; read the license for the thresholds.

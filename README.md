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

> ### 🚧 Status: scaffold
>
> This repository has just been initialized. The workspace, CI, Dependabot and
> the test harness are in place, and the shared runtime in
> `packages/core` is real, but the [Mastra](https://mastra.ai) adapter's bridge
> into the framework is still a typed stub — see
> [`packages/mastra/README.md`](packages/mastra/README.md) for exactly what
> works today and what does not. Nothing here is published to npm yet.

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

Run it under a sidecar:

```bash
dapr run --app-id support-agent --resources-path ./resources -- node dist/agent.js
```

> The `invoke()` call above will throw today: the model bridge is unimplemented.
> The lifecycle, naming, registry metadata and durable control flow around it
> are real and tested.

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
3. **State store** — Dapr saves workflow state after every activity. A separate
   checkpointer persists conversation transcripts, so a _new_ workflow can pick
   up a thread an earlier one finished.

Your code runs anywhere — laptop, Kubernetes, EC2 — while the workflow engine
owns the agent's execution state.

## Repository layout

```text
packages/core      @diagrid/agent-core    shared runtime: base runner, agent
                                          mapper contract, workflow naming,
                                          state, pub/sub, telemetry
packages/mastra    @diagrid/agent-mastra  the Mastra adapter
tests/             mirrors the source tree; `tests/guards/` holds the two
                   invariants CI enforces directly
```

## Adding another framework

The repository is laid out so a second framework is a small, well-bounded
change. Everything framework-specific lives in one package:

1. `mkdir packages/<framework>` and copy `packages/mastra`'s shape: `runner.ts`
   (public entrypoint), `workflow.ts` (Dapr workflow + activities),
   `models.ts` (Zod I/O schemas), `state.ts` (checkpoints), `mapper.ts`
   (`BaseAgentMapper` implementation), `version.ts`, `index.ts`, `README.md`.
2. Add the framework to `SupportedFrameworks` in
   `packages/core/src/types/frameworks.ts`.
3. Add an entry to `ADAPTERS` in
   `tests/guards/cross-framework-imports.test.ts` — that guard fails until you
   do, which is the point.
4. Add a `package-ecosystem: npm` block for the new directory in
   `.github/dependabot.yml`, and a publish step in
   `.github/workflows/npm-release.yaml`.

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

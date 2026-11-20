# Durable Workflows for TypeScript AI agents

Durable execution for TypeScript AI agents on Dapr Workflows.

[![npm: @diagrid/agent-mastra](https://img.shields.io/npm/v/@diagrid/agent-mastra?label=%40diagrid%2Fagent-mastra)](https://www.npmjs.com/package/@diagrid/agent-mastra)
[![npm: @diagrid/n8n](https://img.shields.io/npm/v/@diagrid/n8n?label=%40diagrid%2Fn8n)](https://www.npmjs.com/package/@diagrid/n8n)
[![Build](https://github.com/diagridio/typescript-ai/actions/workflows/build.yaml/badge.svg)](https://github.com/diagridio/typescript-ai/actions/workflows/build.yaml)
[![License: BUSL-1.1](https://img.shields.io/badge/license-BUSL--1.1-blue)](LICENSE.md)

**Make your AI agents resilient to failure and outages**

`@diagrid/*` is a set of extension packages for the open-source
[Dapr](https://github.com/dapr/dapr) project, built by Diagrid, that give
TypeScript AI agents and workflows durable execution. Each adapter runs a
framework on Dapr Workflows so work recovers from crashes, persists state
across restarts, and survives provider outages without re-running (and
re-paying for) steps that already completed.

This is the TypeScript sibling of
[`diagridio/python-ai`](https://github.com/diagridio/python-ai),
[`diagridio/dotnet-ai`](https://github.com/diagridio/dotnet-ai),
[`diagridio/go-ai`](https://github.com/diagridio/go-ai),
[`diagridio/java-ai`](https://github.com/diagridio/java-ai) and
[`diagridio/rust-ai`](https://github.com/diagridio/rust-ai).

Get started with [Diagrid for free](https://diagrid.ws/get-catalyst). Diagrid
has a permanent free tier.

## Packages

All three packages are public on npm. Each is at `0.2.0`, and every version from
`0.1.1` on carries an npm provenance attestation:

| Package                                                                        | What it is                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| [`@diagrid/agent-mastra`](https://www.npmjs.com/package/@diagrid/agent-mastra) | The [Mastra](https://mastra.ai) agent adapter                 |
| [`@diagrid/n8n`](https://www.npmjs.com/package/@diagrid/n8n)                   | Durable execution of [n8n](https://n8n.io) workflow node runs |
| [`@diagrid/agent-core`](https://www.npmjs.com/package/@diagrid/agent-core)     | The shared runtime both build on                              |

The Mastra adapter runs real agent turns as Dapr Workflows, verified end to end
against both a local sidecar and Diagrid: tool calls execute as separate
checkpointed activities, and a process killed mid-turn resumes without
recomputing completed work. See
[`packages/mastra/README.md`](packages/mastra/README.md) for the detail, and
[`packages/n8n/README.md`](packages/n8n/README.md) for the n8n integration and
its current gaps.

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
  framework. [Mastra](https://mastra.ai) is the agent framework supported
  today.
- **n8n:** `@diagrid/n8n` attaches to a stock [n8n](https://n8n.io) process at
  load time (`NODE_OPTIONS="--require @diagrid/n8n/register" n8n start`), with
  no fork and no upstream changes. Each node run becomes a durable Dapr
  activity guarded by an idempotency ledger, so a multi-node workflow resumes
  from its last completed node after a crash.

## Installation

Install the shared runtime plus the adapter for your framework:

```bash
# For Mastra
pnpm add @diagrid/agent-mastra @mastra/core zod

# For n8n (attaches to an existing n8n install). Run this in the directory of
# your n8n install and start n8n from there: `--require @diagrid/n8n/register`
# resolves from that directory's node_modules, so installing it in an
# unrelated project fails with a module-not-found error when n8n starts.
pnpm add @diagrid/n8n zod
```

`@diagrid/agent-core` comes in as a dependency of the adapter; you only need to
install it directly if you are writing an adapter of your own. The framework
SDK (`@mastra/core`) and `zod` are **peer dependencies**, so your application
controls their versions and installing one adapter never pulls in another
framework. Name them on the install line, since a peer dependency is not
installed for you. The n8n packages that `@diagrid/n8n` peers on come from your
existing n8n install, so only `zod` needs naming there.

## Prerequisites

- **Node.js:** 22.13 or newer (Node 20 is end-of-life; `@mastra/core` requires
  ≥ 22.13)
- **Dapr:** a Dapr sidecar, either self-hosted (`dapr init`, needs Docker) or
  managed via [Diagrid](https://diagrid.ws/get-catalyst)
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

Run it under a sidecar — either self-hosted Dapr or managed by Diagrid:

```bash
# Local Dapr: components come from ./resources
dapr run --app-id support-agent --resources-path ./resources -- node dist/agent.js

# Diagrid: components come from the Diagrid project
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
   to the scheme the Python, Go, .NET and Java SDKs use, so one Diagrid project
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
packages/n8n       @diagrid/n8n           durable n8n workflow node runs,
                                          attached via --require
examples/mastra                           runnable Mastra scripts, type-checked
                                          in CI
examples/n8n                              n8n crash-recovery and regression
                                          scripts
tests/             mirrors the source tree; `tests/guards/` holds the two
                   invariants CI enforces directly
```

Start with [`examples/mastra/`](examples/mastra/) — `pnpm inspect` there needs no
API key and no sidecar, and prints exactly what Diagrid publishes about an agent.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md), including
[adding another framework](CONTRIBUTING.md#adding-another-framework).

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

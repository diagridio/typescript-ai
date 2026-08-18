# @diagrid/agent-core

The shared Dapr Workflow runtime behind the Diagrid AI agent adapters.

Application code normally installs an adapter (e.g.
[`@diagrid/agent-mastra`](../mastra/README.md)) rather than this package
directly. Install it directly when you are **writing an adapter** — this is the
package whose two base classes you implement.

## What lives here

| Module          | Export                                    | Role                                                                                         |
| --------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `agent/`        | `agentWorkflow`, `invokeModelActivity`, … | **The durable agent loop** — orchestrator, activities and activity retry, framework-agnostic |
| `agent/`        | `agentWorkflowInputSchema`, …             | Zod schemas for everything crossing the workflow boundary                                    |
| `workflow/`     | `BaseWorkflowRunner`                      | Runtime lifecycle, canonical workflow naming, status/terminate/purge, graceful shutdown      |
| `workflow/`     | `buildWorkflowName`, `sanitizeAgentName`  | The cross-language naming contract (`dapr.<framework>.<AgentName>.workflow`)                 |
| `mapping/`      | `BaseAgentMapper`, `AgentMapper`          | **The framework extension point** — maps a native agent onto registry metadata               |
| `metadata/`     | `agentMetadataRecordSchema`, …            | Zod schemas for the agent registry record                                                    |
| `state/`        | `DaprStateStore`                          | JSON-serializing wrapper over a Dapr state store component                                   |
| `state/`        | `DaprAgentCheckpointer`                   | Conversation-memory checkpoints; key layout shared with `python-ai`, prefix per adapter      |
| `pubsub/`       | `DaprPubSub`                              | Publisher for agent lifecycle events                                                         |
| `telemetry/`    | `setupTelemetry`, `getTracer`             | OTLP/gRPC tracing — a **no-op** unless `OTEL_EXPORTER_OTLP_ENDPOINT` (or config) is set      |
| `workflow/dapr` | Dapr workflow types                       | Type-only re-exports, so adapters never depend on `@dapr/dapr` themselves                    |

### Why the agent loop is here and not in an adapter

It began in the Mastra adapter, and a review made the consequence plain: none of
it mentions a framework. A message, a tool call, one model turn, the retry
policy and the checkpoint key layout are the same shapes whichever SDK produced
them — so adapter #2 would have copied the whole durable loop, including
invariants that are easy to get subtly wrong (the orchestrator must be an
`async function*`; the schema-parse must sit _outside_ the retry region; the
clock must come from `getCurrentUtcDateTime()`). Two copies drift, and the
drift is silent.

What is genuinely per-framework is small: driving the SDK one step at a time so
tool execution stays inside checkpointed activities, and reading a native agent
structurally for its metadata.

## Writing an adapter

Two things to implement:

<!-- typecheck: skip — a template for a future adapter, not runnable code:
     `MY_FRAMEWORK`, `myAgentWorkflow` and `myActivity` are placeholders the
     implementer replaces. Checked blocks live in the root and mastra READMEs. -->

```ts
import {
  BaseAgentMapper,
  BaseWorkflowRunner,
  SupportedFrameworks,
  type AgentMapper,
  type AgentMetadataRecord,
  type SupportedFramework,
  type WorkflowRuntime,
} from '@diagrid/agent-core';

class MyFrameworkMapper extends BaseAgentMapper {
  readonly framework: SupportedFramework = SupportedFrameworks.MY_FRAMEWORK;

  // Async by contract: frameworks commonly hide an agent's config behind async
  // accessors (Mastra's `Agent.listTools()` returns a Promise), and a sync
  // mapper would silently report empty tools for every real agent.
  async mapAgentMetadata(agent: unknown): Promise<AgentMetadataRecord> {
    // Read the framework-native agent, then hand the partial record to
    // `this.finalize(...)`, which fills defaults, derives the workflow name
    // and validates the result.
    return this.finalize({/* … */});
  }
}

class MyFrameworkRunner extends BaseWorkflowRunner {
  readonly #mapper = new MyFrameworkMapper();

  get mapper(): AgentMapper {
    return this.#mapper;
  }

  protected registerWorkflowComponents(runtime: WorkflowRuntime): void {
    runtime.registerWorkflowWithName(this.workflowName, myAgentWorkflow);
    runtime.registerActivityWithName('…', myActivity);
  }
}
```

Two rules the CI guards enforce:

- **Import the framework SDK as a peer, never a dependency.** Read native agents
  structurally so the framework stays out of the runtime graph. Read config
  through the framework's _accessors_ (`getInstructions()`, `listTools()`), not
  its plain properties — a real instance usually keeps those private, and a
  property-only mapper passes every fixture-based test while reporting nothing
  for real agents.
- **Import Dapr types from here, not from `@dapr/dapr`.** One package owns the
  SDK version; see `src/workflow/dapr.ts` for why.

Then add an `ADAPTERS` entry in
`tests/guards/cross-framework-imports.test.ts` — it fails until you do.

## Telemetry

`setupTelemetry()` returns `undefined` when no OTLP endpoint is configured, and
that is success, not an error — it is the normal local-dev path. `getTracer()`
is always safe to call: with no provider registered the OTel API hands back a
no-op tracer, so instrumentation never has to branch on whether tracing is on.

Resolution precedence for the endpoint is explicit config → then
`OTEL_EXPORTER_OTLP_ENDPOINT`, with `enabled: false` short-circuiting either.
Signal path suffixes (`/v1/traces`) are stripped, because the gRPC exporter wants
a bare `host:port`.

## License

[Business Source License 1.1](../../LICENSE.md) — © 2026–Present Diagrid Inc.

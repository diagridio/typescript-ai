// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Public entrypoint: run a Mastra agent as a Dapr Workflow.
 *
 * ```ts
 * import { Agent } from '@mastra/core/agent';
 * import { openai } from '@ai-sdk/openai';
 * import { DaprWorkflowAgentRunner } from '@diagrid/agent-mastra';
 *
 * const agent = new Agent({
 *   id: 'support-agent',
 *   name: 'support-agent',
 *   instructions: 'You help customers with billing questions.',
 *   model: openai('gpt-4o-mini'),
 * });
 *
 * const runner = new DaprWorkflowAgentRunner({ agent, name: 'support-agent' });
 * await runner.start();
 *
 * const result = await runner.invoke({
 *   prompt: 'Why was I charged twice?',
 *   threadId: 'thread-123',
 * });
 *
 * await runner.shutdown();
 * ```
 *
 * Each model call and each tool execution becomes a checkpointed Dapr activity,
 * so a process killed mid-turn resumes from the last completed activity instead
 * of re-running the turn. See `./bridge.ts` for how Mastra is driven one step at
 * a time, and `examples/mastra/crash-recovery.ts` for a demonstration that
 * completed work is not recomputed.
 */

import {
  BaseWorkflowRunner,
  WorkflowRuntimeStatus,
  workflowStatusName,
  type AgentMapper,
  type AgentMetadataRecord,
  type BaseWorkflowRunnerOptions,
  SupportedFrameworks,
  type WorkflowActivityContext,
  type WorkflowRuntime,
  type WorkflowState,
} from '@diagrid/agent-core';

import { createModelInvoker, createToolInvokers } from './bridge';
import { MastraAgentMapper, type MastraAgentLike } from './mapper';
import {
  agentWorkflowOutputSchema,
  type AgentWorkflowInput,
  type AgentWorkflowOutput,
} from '@diagrid/agent-core';
import { DaprMastraCheckpointer } from './state';
import {
  activityNamesFor,
  agentWorkflow,
  invokeModelActivity,
  invokeToolActivity,
  type ModelInvoker,
  type ToolInvoker,
} from '@diagrid/agent-core';

export interface DaprWorkflowAgentRunnerOptions extends BaseWorkflowRunnerOptions {
  /** The Mastra agent to make durable. */
  readonly agent: MastraAgentLike;
  /** Checkpointer for conversation memory. Defaults to the shared state store. */
  readonly checkpointer?: DaprMastraCheckpointer;
  /** Seconds to wait for a workflow to complete in {@link invoke}. */
  readonly invokeTimeoutSeconds?: number;
}

/** How long {@link DaprWorkflowAgentRunner.invoke} waits before giving up. */
const DEFAULT_INVOKE_TIMEOUT_SECONDS = 300;

/**
 * Thrown when a turn does not finish in time.
 *
 * Carries `workflowId` because the workflow is still running and still making
 * billed model calls when this fires. `invoke()` creates the id internally, so
 * without it on the error the caller has no handle to reattach with
 * {@link DaprWorkflowAgentRunner.waitFor}, terminate, or purge.
 */
export class WorkflowTimeoutError extends Error {
  override readonly name = 'WorkflowTimeoutError';

  constructor(
    readonly workflowId: string,
    readonly timeoutSeconds: number,
    options?: ErrorOptions
  ) {
    super(
      `Workflow "${workflowId}" did not complete within ${timeoutSeconds}s. ` +
        'It is still running — reattach with runner.waitFor(workflowId), or ' +
        'terminate it.',
      options
    );
  }
}

/**
 * Did this workflow complete successfully?
 *
 * Takes a plain `number` rather than comparing inline, because core declares
 * `WorkflowRuntimeStatus` itself instead of re-exporting the SDK's — that is
 * what keeps `@dapr/dapr` out of core's static import graph. The two are
 * nominally distinct types over the same protobuf values, which an inline
 * comparison would (fairly) flag as mixing enums.
 * `tests/core/workflow/status.test.ts` fails if the values ever stop agreeing.
 */
function isCompleted(status: number): boolean {
  return status === WorkflowRuntimeStatus.COMPLETED;
}

/**
 * Is this the SDK's own timeout, as opposed to any other gRPC failure?
 *
 * `waitForOrchestrationCompletion` races the call against a timer and throws its
 * private `TimeoutError` when the timer wins — but its `catch` also re-throws
 * every real transport error unchanged, so the two arrive identically. The
 * class is not exported, so this matches on the one thing it is identifiable by:
 * its constructor calls `super('TimeoutError')` and never sets `name`, leaving
 * the message as the discriminator. `@dapr/dapr` is pinned to an exact version,
 * so this cannot drift without a deliberate dependency bump.
 * `tests/mastra/runner-invoke.test.ts` pins both directions.
 */
function isSdkTimeout(cause: unknown): boolean {
  return cause instanceof Error && cause.message === 'TimeoutError';
}

export class DaprWorkflowAgentRunner extends BaseWorkflowRunner {
  readonly agent: MastraAgentLike;
  readonly checkpointer: DaprMastraCheckpointer;

  readonly #mapper = new MastraAgentMapper();
  readonly #invokeTimeoutSeconds: number;

  /**
   * This runner's own invokers.
   *
   * Instance state, not module state: activities close over these, so two
   * runners in one process are fully isolated. Populated lazily — the model
   * invoker on first use, the tools during `start()` (reading them is async).
   */
  #modelInvoker: ModelInvoker | undefined;
  #toolInvokers = new Map<string, ToolInvoker>();

  constructor(options: DaprWorkflowAgentRunnerOptions) {
    super(SupportedFrameworks.MASTRA, options);
    this.agent = options.agent;
    this.checkpointer =
      options.checkpointer ??
      new DaprMastraCheckpointer({ stateStore: this.stateStore });
    this.#invokeTimeoutSeconds =
      options.invokeTimeoutSeconds ?? DEFAULT_INVOKE_TIMEOUT_SECONDS;
  }

  override get mapper(): AgentMapper {
    return this.#mapper;
  }

  /**
   * This agent's registry metadata record.
   *
   * A method rather than a getter because it is async: Mastra exposes an
   * agent's tools only through `listTools()`, which returns a Promise. See the
   * note on {@link AgentMapper.mapAgentMetadata}.
   */
  getMetadata(): Promise<AgentMetadataRecord> {
    return this.#mapper.mapAgentMetadata(this.agent, { name: this.name });
  }

  /**
   * Run one agent turn to completion.
   *
   * Schedules the durable workflow, waits for it, and returns the parsed
   * output. Prefer {@link schedule} when the caller should not block — a long
   * agent turn outliving an HTTP request is the normal case, not the
   * exception.
   */
  async invoke(
    input: AgentWorkflowInput,
    options: { workflowId?: string } = {}
  ): Promise<AgentWorkflowOutput> {
    const workflowId = await this.schedule(input, options);
    return this.waitFor(workflowId);
  }

  /**
   * Wait for an already-scheduled turn and return its output.
   *
   * This is how crash recovery is driven, and it is separate from
   * {@link invoke} because Dapr's semantics require it to be. An interrupted
   * workflow instance stays **active**: the engine redelivers its pending work as
   * soon as a worker reconnects, so a restarted process must attach to that
   * instance rather than schedule anything. Calling
   * `scheduleNewWorkflow` again with the same id does not resume it — Dapr
   * rejects it outright with *"an active workflow with ID … already exists"*.
   *
   * So a process that may be recovering should `start()` the runtime, then call
   * this with the known workflow id.
   */
  async waitFor(workflowId: string): Promise<AgentWorkflowOutput> {
    const client = this.requireClient();

    // The two failure modes are distinct in the SDK, and were previously
    // conflated. `waitForOrchestrationCompletion` **rejects** with a TimeoutError
    // on timeout, and resolves `undefined` only when the instance does not
    // exist. So the friendly timeout message used to fire instantly on a missing
    // id — the `waitFor()` recovery path with a purged or mistyped workflow —
    // while a real timeout propagated raw. TimeoutError's constructor never sets
    // `name`, so that surfaced as `Error: TimeoutError` with no id and no
    // duration.
    let state: WorkflowState | undefined;
    try {
      state = await client.waitForWorkflowCompletion(
        workflowId,
        true,
        this.#invokeTimeoutSeconds
      );
    } catch (cause) {
      // Only an actual timeout may be reported as one. The SDK re-throws
      // whatever the gRPC call produced — sidecar down, TLS rejected, bad API
      // token, network gone — through the same path as its manufactured
      // timeout. Wrapping all of them would tell an operator "it is still
      // running, reattach later" when nothing is running and the sidecar is
      // unreachable: worse than no message at all, because it sends them
      // looking for an instance instead of at their connection.
      if (!isSdkTimeout(cause)) {
        throw cause;
      }

      throw new WorkflowTimeoutError(workflowId, this.#invokeTimeoutSeconds, {
        cause,
      });
    }

    if (!state) {
      throw new Error(`No workflow instance "${workflowId}" exists`);
    }

    // A workflow that failed or was terminated has no output worth parsing, and
    // Dapr reports that through the runtime status rather than by rejecting.
    // Without this check a failed run surfaces as an opaque schema error.
    if (!isCompleted(state.runtimeStatus)) {
      throw new Error(
        `Workflow "${workflowId}" ended with status ` +
          workflowStatusName(state.runtimeStatus) +
          (state.workflowFailureDetails
            ? `: ${state.workflowFailureDetails.getErrorType()}: ` +
              `${state.workflowFailureDetails.getErrorMessage()}`
            : '')
      );
    }

    // `serializedOutput` is a JSON *string*, not an object — the SDK's own
    // naming says so. Handing it straight to a Zod object schema always threw;
    // nothing caught it because no test ever executed a workflow.
    if (state.serializedOutput === undefined) {
      throw new Error(
        `Workflow "${workflowId}" completed without producing output`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(state.serializedOutput);
    } catch (cause) {
      throw new Error(
        `Workflow "${workflowId}" produced output that is not valid JSON`,
        { cause }
      );
    }

    return agentWorkflowOutputSchema.parse(parsed);
  }

  /**
   * Schedule an agent turn and return its workflow instance id.
   *
   * Pass `workflowId` to control the Dapr instance id. This is what makes crash
   * recovery possible, and it is opt-in for a reason:
   *
   * - **Omitted** — Dapr assigns a fresh id, so every call is a new turn. Right
   *   for ordinary use, where two turns on one thread must not collide.
   * - **Supplied** — the turn is pinned to that id, so a restarted process can
   *   find it again. Recovery is *not* done by scheduling again: Dapr rejects a
   *   duplicate active id. Use {@link waitFor} to attach to it instead.
   *
   * There is no safe default here: deriving the id from `threadId` alone would
   * make the second turn of a conversation collide with the first. The caller
   * knows what identifies a turn; the adapter does not.
   *
   * An earlier version of this method claimed in its own doc comment to derive
   * the id from the thread id, while passing no id at all. `crash-recovery.ts`
   * is what caught it — run 2 quietly started a new workflow and re-ran work the
   * first run had already completed.
   */
  async schedule(
    input: AgentWorkflowInput,
    options: { workflowId?: string } = {}
  ): Promise<string> {
    const client = this.requireClient();
    return client.scheduleNewWorkflow(
      this.workflowName,
      // The runner's `maxIterations` is the default for turns it schedules;
      // an explicit value on the input still wins.
      //
      // `??` rather than spread order. `AgentWorkflowInput` is a `z.input`, so
      // `maxIterations` is optional — and object spread cannot tell "key absent"
      // from "key present, value undefined". Callers that build input by
      // spreading a Partial hit the latter, which would silently overwrite the
      // runner's value and fall through to the schema's own default of 25.
      {
        ...input,
        maxIterations: input.maxIterations ?? this.maxIterations,
        // The orchestrator calls whatever names this runner registered.
        activityNames: activityNamesFor(SupportedFrameworks.MASTRA, this.name),
      },
      options.workflowId
    );
  }

  /**
   * Override the model invoker.
   *
   * Wrapping the real one is the supported way to observe or interrupt model
   * calls — `examples/mastra/crash-recovery.ts` uses it to kill the process
   * mid-turn. The default is created lazily on first read of `modelInvoker`, so this may
   * be called before or after `start()`; the registered activity re-reads the
   * accessor on every call either way.
   */
  setModelInvoker(invoker: ModelInvoker): void {
    this.#modelInvoker = invoker;
  }

  /** The invoker in force, defaulting to the real bridge into Mastra. */
  get modelInvoker(): ModelInvoker {
    this.#modelInvoker ??= createModelInvoker(this.agent);
    return this.#modelInvoker;
  }

  /** Register the workflow and its activities. Called once from `start()`. */
  protected override registerWorkflowComponents(
    runtime: WorkflowRuntime
  ): void {
    runtime.registerWorkflowWithName(this.workflowName, agentWorkflow);

    // Closures over this runner's own state. `registerActivityWithName` accepts
    // any function, and activities are invoked rather than replayed, so there is
    // no reason for the invokers to live at module scope — and every reason not
    // to: a module-level registry let a second runner in the same process
    // silently answer the first one's durable turns.
    //
    // Read through the accessors, not captured by value: `setModelInvoker()` may
    // replace the invoker after registration, and tools are loaded during
    // `start()`.
    // Registered under names scoped to this agent — see `activityNamesFor`.
    // Registering under the shared literals would let a second runner on the
    // same sidecar service this one's work items with its own tools.
    const model = (ctx: WorkflowActivityContext, input: unknown) =>
      invokeModelActivity(ctx, input, this.modelInvoker);
    const tool = (ctx: WorkflowActivityContext, input: unknown) =>
      invokeToolActivity(ctx, input, this.#toolInvokers);

    const activities = activityNamesFor(SupportedFrameworks.MASTRA, this.name);
    runtime.registerActivityWithName(activities.model, model);
    runtime.registerActivityWithName(activities.tool, tool);
  }

  /**
   * Start the runtime, then register one invoker per Mastra tool.
   *
   * Split from {@link registerWorkflowComponents} because that hook is
   * synchronous by Dapr's contract while `agent.listTools()` is async. Ordering
   * is safe: `super.start()` has already registered the workflow and its
   * activities, and nothing can schedule a workflow until this returns.
   */
  override async start(): Promise<void> {
    await super.start();

    try {
      this.#toolInvokers = await createToolInvokers(this.agent);
    } catch (error) {
      // Reading tools can fail — they may come from an MCP client that is
      // unreachable. Without this, `start()` rejects *after* the base class has
      // already registered and started the Dapr runtime, leaving a live worker
      // with an empty invoker map: every tool call then returns "Unknown tool"
      // as a checkpointed success, burning iterations at full model-call cost,
      // on a runner the caller believes never started.
      await super.shutdown();
      throw error;
    }
  }

  /** Release the checkpointer alongside the base runner's resources. */
  override async shutdown(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    // The checkpointer shares this runner's state store by default, which the
    // base class already closes; closing it again is a no-op by design.
    await super.shutdown();
    // Only this runner's own invokers are dropped. The previous version cleared
    // a module-level registry here, which emptied it for any other runner still
    // serving in the same process.
    this.#toolInvokers = new Map();
    this.#modelInvoker = undefined;
  }
}

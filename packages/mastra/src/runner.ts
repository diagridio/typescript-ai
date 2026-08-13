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
  type AgentMapper,
  type AgentMetadataRecord,
  type BaseWorkflowRunnerOptions,
  SupportedFrameworks,
  type WorkflowRuntime,
} from '@diagrid/agent-core';

import { createModelInvoker, createToolInvokers } from './bridge';
import { MastraAgentMapper, type MastraAgentLike } from './mapper';
import {
  agentWorkflowOutputSchema,
  type AgentWorkflowInput,
  type AgentWorkflowOutput,
} from './models';
import { DaprMastraCheckpointer } from './state';
import {
  ACTIVITY_INVOKE_MODEL,
  ACTIVITY_INVOKE_TOOL,
  agentWorkflow,
  clearRegistries,
  invokeModelActivity,
  invokeToolActivity,
  registerModelInvoker,
  registerToolInvoker,
} from './workflow';

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

export class DaprWorkflowAgentRunner extends BaseWorkflowRunner {
  readonly agent: MastraAgentLike;
  readonly checkpointer: DaprMastraCheckpointer;

  readonly #mapper = new MastraAgentMapper();
  readonly #invokeTimeoutSeconds: number;

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

    const state = await client.waitForWorkflowCompletion(
      workflowId,
      true,
      this.#invokeTimeoutSeconds
    );

    if (!state) {
      throw new Error(
        `Workflow "${workflowId}" did not complete within ${this.#invokeTimeoutSeconds}s`
      );
    }

    // A workflow that failed or was terminated has no output worth parsing, and
    // Dapr reports that through the runtime status rather than by rejecting.
    // Without this check a failed run surfaces as an opaque schema error.
    if (state.runtimeStatus !== WorkflowRuntimeStatus.COMPLETED) {
      throw new Error(
        `Workflow "${workflowId}" ended with status ` +
          `${WorkflowRuntimeStatus[state.runtimeStatus] ?? state.runtimeStatus}` +
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
      input,
      options.workflowId
    );
  }

  /** Register the workflow and its activities. Called once from `start()`. */
  protected override registerWorkflowComponents(
    runtime: WorkflowRuntime
  ): void {
    // Module-level registries survive between runner instances in the same
    // process, so clear them first: two runners in one process must not see
    // each other's tools.
    clearRegistries();

    // One model call per iteration, tools offered but never executed by Mastra
    // — see the header of ./bridge.ts for why `clientTools` + `maxSteps: 1` is
    // the only combination that both calls tools and keeps execution durable.
    registerModelInvoker(createModelInvoker(this.agent));

    // Tool invokers are *not* registered here. Reading an agent's tools requires
    // `await agent.listTools()`, but Dapr requires workflow and activity
    // registration to be synchronous and finished before the runtime starts —
    // so they are registered in `start()`, after `super.start()` returns and
    // before any workflow can be scheduled.
    runtime.registerWorkflowWithName(this.workflowName, agentWorkflow);
    runtime.registerActivityWithName(
      ACTIVITY_INVOKE_MODEL,
      invokeModelActivity
    );
    runtime.registerActivityWithName(ACTIVITY_INVOKE_TOOL, invokeToolActivity);
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

    const invokers = await createToolInvokers(this.agent);
    for (const [name, invoker] of invokers) {
      registerToolInvoker(name, invoker);
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
    clearRegistries();
  }
}

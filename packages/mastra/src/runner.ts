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
 * ## Status
 *
 * Skeleton. Lifecycle, naming, registration wiring and the invoke/poll path
 * are real; the two bridges into Mastra — turning the agent's model into a
 * durable activity, and turning its tools into durable activities — are typed
 * stubs marked `TODO(mastra-adapter)`. `invoke()` therefore fails loudly
 * against a live sidecar today rather than returning a fabricated answer.
 */

import {
  BaseWorkflowRunner,
  type AgentMapper,
  type AgentMetadataRecord,
  type BaseWorkflowRunnerOptions,
  SupportedFrameworks,
  type WorkflowRuntime,
} from '@diagrid/agent-core';

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
  async invoke(input: AgentWorkflowInput): Promise<AgentWorkflowOutput> {
    const workflowId = await this.schedule(input);
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

    return agentWorkflowOutputSchema.parse(state.serializedOutput);
  }

  /**
   * Schedule an agent turn and return its workflow instance id.
   *
   * The instance id is derived from the thread id so a retry of the same turn
   * is idempotent at the Dapr level rather than starting a second agent.
   */
  async schedule(input: AgentWorkflowInput): Promise<string> {
    const client = this.requireClient();
    return client.scheduleNewWorkflow(this.workflowName, input);
  }

  /** Register the workflow and its activities. Called once from `start()`. */
  protected override registerWorkflowComponents(
    runtime: WorkflowRuntime
  ): void {
    // Module-level registries survive between runner instances in the same
    // process, so clear them first: two runners in one process must not see
    // each other's tools.
    clearRegistries();

    registerModelInvoker((_modelInput) => {
      // TODO(mastra-adapter): bridge to Mastra. Call the agent's configured
      // model with `_modelInput.messages` (converted to AI SDK message parts)
      // and the tool definitions named in `_modelInput.toolNames`, then map the
      // response back onto `InvokeModelOutput`. Must resolve the model through
      // `agent.getModel()` rather than `agent.model`, since Mastra allows a
      // dynamic model factory.
      throw new Error(
        `${ACTIVITY_INVOKE_MODEL} is not implemented yet — the Mastra adapter is a scaffold. ` +
          'See packages/mastra/src/runner.ts (TODO: bridge to Mastra).'
      );
    });

    // TODO(mastra-adapter): enumerate `agent.getTools()` and register one
    // invoker per tool, validating args against the tool's `inputSchema`
    // before execution. Left unregistered rather than stubbed, so
    // `invokeToolActivity` reports an honest "Unknown tool" instead of a fake
    // result.
    void registerToolInvoker;

    runtime.registerWorkflowWithName(this.workflowName, agentWorkflow);
    runtime.registerActivityWithName(
      ACTIVITY_INVOKE_MODEL,
      invokeModelActivity
    );
    runtime.registerActivityWithName(ACTIVITY_INVOKE_TOOL, invokeToolActivity);
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

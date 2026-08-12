// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Dapr Workflow definition for durable Mastra agent execution.
 *
 * The shape mirrors `diagrid/agent/langgraph/workflow.py` in
 * `diagridio/python-ai`: the agent's control loop becomes the orchestrator,
 * and every non-deterministic step — each model call, each tool execution —
 * becomes a durable activity. Dapr checkpoints the orchestrator's history
 * after every activity, so a crash mid-turn resumes from the last completed
 * activity instead of re-running the whole turn (and re-billing the LLM
 * calls).
 *
 * Registries are module-level because Dapr must be handed plain functions at
 * registration time: the orchestrator cannot close over the live Mastra
 * `Agent` (it would not survive replay), so the runner registers the agent's
 * model and tools here by name and the activities look them up.
 *
 * ## Status
 *
 * Skeleton. The orchestrator's control flow is real and the activity contracts
 * are fixed, but the two activity bodies that touch Mastra are stubs — see the
 * `TODO(mastra-adapter)` markers. Nothing here fakes a working integration:
 * an unimplemented activity throws rather than returning a plausible-looking
 * result.
 */

import type {
  WorkflowActivityContext,
  WorkflowContext,
} from '@diagrid/agent-core';

import {
  agentWorkflowInputSchema,
  invokeModelInputSchema,
  invokeModelOutputSchema,
  invokeToolInputSchema,
  invokeToolOutputSchema,
  WorkflowStatus,
  type AgentWorkflowOutput,
  type InvokeModelOutput,
  type InvokeToolOutput,
  type Message,
} from './models';

/** Activity names, also the registration names on the Dapr runtime. */
export const ACTIVITY_INVOKE_MODEL = 'diagrid.mastra.invokeModel';
export const ACTIVITY_INVOKE_TOOL = 'diagrid.mastra.invokeTool';

/**
 * A model invoker: everything the `invokeModel` activity needs in order to
 * produce one assistant message. Registered by the runner.
 */
export type ModelInvoker = (
  input: ReturnType<typeof invokeModelInputSchema.parse>
) => Promise<InvokeModelOutput>;

/** A single tool's executor. Registered by the runner, keyed by tool name. */
export type ToolInvoker = (
  input: ReturnType<typeof invokeToolInputSchema.parse>
) => Promise<InvokeToolOutput>;

interface Registries {
  modelInvoker: ModelInvoker | undefined;
  toolInvokers: Map<string, ToolInvoker>;
}

const registries: Registries = {
  modelInvoker: undefined,
  toolInvokers: new Map(),
};

/** Register the function the `invokeModel` activity delegates to. */
export function registerModelInvoker(invoker: ModelInvoker): void {
  registries.modelInvoker = invoker;
}

/** Register one tool executor under the name the model will call it by. */
export function registerToolInvoker(name: string, invoker: ToolInvoker): void {
  registries.toolInvokers.set(name, invoker);
}

/** Names of every registered tool, in registration order. */
export function registeredToolNames(): string[] {
  return [...registries.toolInvokers.keys()];
}

/**
 * Drop every registration.
 *
 * Exported for tests: the registries are module-level, so a suite that
 * registers invokers has to reset them or it leaks into the next test.
 */
export function clearRegistries(): void {
  registries.modelInvoker = undefined;
  registries.toolInvokers = new Map();
}

/**
 * Activity: one model call.
 *
 * Runs outside the orchestrator so it may be non-deterministic, and is
 * checkpointed on completion so a replay never re-issues the call.
 */
export async function invokeModelActivity(
  _ctx: WorkflowActivityContext,
  rawInput: unknown
): Promise<InvokeModelOutput> {
  const input = invokeModelInputSchema.parse(rawInput);
  const invoker = registries.modelInvoker;

  if (!invoker) {
    throw new Error(
      `No model invoker registered — ${ACTIVITY_INVOKE_MODEL} cannot run. ` +
        'DaprWorkflowAgentRunner.start() is responsible for registering one.'
    );
  }

  return invokeModelOutputSchema.parse(await invoker(input));
}

/**
 * Activity: one tool execution.
 *
 * A tool that throws is reported back to the orchestrator as an `error` on the
 * output rather than failing the activity, so the model gets a chance to
 * recover from a bad call. Infrastructure failures still propagate — Dapr's
 * retry policy is the right place to handle those.
 */
export async function invokeToolActivity(
  _ctx: WorkflowActivityContext,
  rawInput: unknown
): Promise<InvokeToolOutput> {
  const input = invokeToolInputSchema.parse(rawInput);
  const invoker = registries.toolInvokers.get(input.toolName);

  if (!invoker) {
    return invokeToolOutputSchema.parse({
      toolCallId: input.toolCallId,
      result: '',
      error: `Unknown tool "${input.toolName}"`,
    });
  }

  return invokeToolOutputSchema.parse(await invoker(input));
}

/**
 * Orchestrator: the durable agent loop.
 *
 * Model call -> tool calls -> repeat, up to `maxIterations`. Written as a
 * generator per the Dapr JS workflow contract; every `yield` is a durable
 * checkpoint. The function body must stay deterministic — no clocks, no
 * randomness, no I/O — because Dapr re-executes it from the top on every
 * replay.
 */
export function* agentWorkflow(
  ctx: WorkflowContext,
  rawInput: unknown
): Generator<unknown, AgentWorkflowOutput, unknown> {
  const input = agentWorkflowInputSchema.parse(rawInput);

  const messages: Message[] = [
    ...input.messages,
    { role: 'user', content: input.prompt },
  ];

  let iteration = 0;

  while (iteration < input.maxIterations) {
    const modelOutput = invokeModelOutputSchema.parse(
      yield ctx.callActivity(ACTIVITY_INVOKE_MODEL, {
        messages,
        toolNames: registeredToolNames(),
        iteration,
        threadId: input.threadId,
      })
    );
    iteration += 1;

    if (modelOutput.error) {
      return {
        text: '',
        messages,
        iterations: iteration,
        status: WorkflowStatus.FAILED,
        error: modelOutput.error,
      };
    }

    messages.push(modelOutput.message);

    const toolCalls = modelOutput.message.toolCalls ?? [];
    if (!modelOutput.requiresToolCalls || toolCalls.length === 0) {
      return {
        text: modelOutput.message.content,
        messages,
        iterations: iteration,
        status: WorkflowStatus.COMPLETED,
      };
    }

    // Tool calls in one turn are independent, so they are scheduled together
    // and awaited as a batch — one round-trip through the orchestrator
    // instead of one per tool.
    // TODO(mastra-adapter): use `ctx.whenAll` once the fan-out shape is
    // settled; sequential `yield`s keep replay ordering trivially stable while
    // the activity contracts are still moving.
    for (const call of toolCalls) {
      const toolOutput = invokeToolOutputSchema.parse(
        yield ctx.callActivity(ACTIVITY_INVOKE_TOOL, {
          toolCallId: call.id,
          toolName: call.name,
          args: call.args,
          threadId: input.threadId,
        })
      );

      messages.push({
        role: 'tool',
        content: toolOutput.error ?? toolOutput.result,
        toolCallId: toolOutput.toolCallId,
      });
    }
  }

  // Loop cap hit without the model settling on a final answer. Reported as a
  // failure rather than a truncated success so a caller cannot mistake a
  // runaway agent for a completed one.
  return {
    text: '',
    messages,
    iterations: iteration,
    status: WorkflowStatus.FAILED,
    error: `Agent exceeded maxIterations (${input.maxIterations}) without producing a final answer`,
  };
}

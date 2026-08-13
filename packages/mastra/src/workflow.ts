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
 * The activity bodies delegate to `./bridge.ts`, which drives Mastra one step at
 * a time so that tool execution stays inside checkpointed activities rather than
 * inside the framework.
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

/**
 * How many times a failing tool activity is attempted, in total.
 *
 * Stands in for a Dapr activity `RetryPolicy`, which the JS SDK does not expose.
 * See the retry loop in {@link agentWorkflow}.
 */
export const TOOL_MAX_ATTEMPTS = 3;

/** First backoff delay; doubles per attempt. */
export const TOOL_RETRY_BASE_DELAY_MS = 500;

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
 * Failure handling splits by *cause*, which is what makes retrying useful:
 *
 * - **Bad arguments** (the model produced input the tool's schema rejects) come
 *   back as an `error` on the output. Retrying cannot fix them; the model can.
 * - **A throw from the tool body** propagates as an activity failure, so the
 *   orchestrator retries it with backoff — see the retry loop in
 *   {@link agentWorkflow}. A rate limit or dropped connection therefore costs a
 *   retry, not an LLM round trip.
 * - **An unknown tool** is an error on the output: nothing will make it appear.
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
 * Model call -> tool calls -> repeat, up to `maxIterations`. Every `yield` is a
 * durable checkpoint. The function body must stay deterministic — no clocks, no
 * randomness, no I/O — because Dapr re-executes it from the top on every replay.
 *
 * ## It must be an `async function*`, not a `function*`
 *
 * This is not stylistic. Dapr's orchestration executor decides what to do with
 * an orchestrator by checking for an **async** iterator:
 *
 * ```js
 * const isAsyncGenerator = typeof result?.[Symbol.asyncIterator] === 'function';
 * if (isAsyncGenerator) { await ctx.run(result); }
 * else { ctx.setComplete(result, ORCHESTRATION_STATUS_COMPLETED); }
 * ```
 *
 * A sync `function*` has `Symbol.iterator` but not `Symbol.asyncIterator`, so it
 * takes the `else` branch: the generator object itself is serialized as the
 * workflow output and the instance is marked **COMPLETED without running a
 * single activity**. Nothing throws. The only visible symptom is an empty result
 * — which is how this shipped unnoticed until an example ran a real workflow and
 * reported `Iterations: 0` with status `completed`.
 */
// `async` is mandated by Dapr's executor (it tests Symbol.asyncIterator);
// suspension happens through `yield`, never `await`, so there is deliberately no
// await in the body. See the note above for what a sync generator does instead.
// eslint-disable-next-line @typescript-eslint/require-await
export async function* agentWorkflow(
  ctx: WorkflowContext,
  rawInput: unknown
): AsyncGenerator<unknown, AgentWorkflowOutput, unknown> {
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
      const activityInput = {
        toolCallId: call.id,
        toolName: call.name,
        args: call.args,
        threadId: input.threadId,
      };

      let toolOutput: InvokeToolOutput | undefined;
      let lastFailure: string | undefined;

      // Retry a failed tool in place, without involving the model.
      //
      // This is what a Dapr `RetryPolicy` on the activity would do, done in the
      // orchestrator because the JS SDK has no such policy: neither
      // `@dapr/dapr@3.18` nor `@dapr/durabletask-js@1.0` accepts one —
      // `callActivity(activity, input)` is the whole signature. (The Python
      // `dapr-ext-workflow` does have `RetryPolicy`.)
      //
      // Doing it here is not a downgrade in durability. Every attempt and every
      // backoff timer is a checkpointed workflow action, so a process killed
      // between attempt 2 and 3 resumes at attempt 3 rather than starting over.
      // The clock comes from `getCurrentUtcDateTime()`, which is replay-stable —
      // `Date.now()` here would be non-deterministic and corrupt replay.
      //
      // TODO(mastra-adapter): switch to a native activity RetryPolicy when the
      // JS SDK gains one, and delete this loop.
      for (let attempt = 1; attempt <= TOOL_MAX_ATTEMPTS; attempt += 1) {
        try {
          toolOutput = invokeToolOutputSchema.parse(
            yield ctx.callActivity(ACTIVITY_INVOKE_TOOL, activityInput)
          );
          lastFailure = undefined;
          break;
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : String(error);

          if (attempt < TOOL_MAX_ATTEMPTS) {
            const delayMs = TOOL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
            yield ctx.createTimer(
              new Date(ctx.getCurrentUtcDateTime().getTime() + delayMs)
            );
          }
        }
      }

      if (toolOutput === undefined) {
        // Retries exhausted. Report it to the model as a tool error rather than
        // failing the turn: a tool that is down is something the agent may be
        // able to work around or explain, and losing the whole conversation is
        // strictly worse.
        messages.push({
          role: 'tool',
          content: `tool failed after ${TOOL_MAX_ATTEMPTS} attempts: ${lastFailure ?? 'unknown error'}`,
          toolCallId: call.id,
        });
        continue;
      }

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

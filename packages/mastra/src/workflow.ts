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
 * Activities receive their invokers as arguments, and the runner binds its own
 * via closures at registration time — see {@link ToolInvokers}. Nothing about an
 * agent lives at module scope, so two runners in one process cannot interfere.
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
 * How many times a failing activity is attempted, in total.
 *
 * Governs both the model call and tool calls. It was `TOOL_MAX_ATTEMPTS` when
 * only tools were retried; once the model call was retried too, that name made
 * the "model call failed after 3 attempts" message read as though it were
 * quoting the wrong constant.
 *
 * Stands in for a Dapr activity `RetryPolicy`, which the JS SDK does not expose.
 * See {@link callActivityWithRetry}.
 */
export const ACTIVITY_MAX_ATTEMPTS = 3;

/** First backoff delay; doubles per attempt. */
export const ACTIVITY_RETRY_BASE_DELAY_MS = 500;

/**
 * Longest tool result kept in the transcript, in characters.
 *
 * A tool result is not paid for once. It stays in `messages`, which is resent to
 * the model on every subsequent iteration *and* embedded in the checkpointed
 * activity input each time — so one oversized payload early in a turn is billed
 * and stored repeatedly for the rest of it. Truncating bounds both curves at the
 * one place they share.
 *
 * Generous enough that ordinary tool output passes untouched.
 */
export const MAX_TOOL_RESULT_CHARS = 16_000;

/** Truncate an oversized tool result, saying so in-band so the model knows. */
function capToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) {
    return content;
  }
  const dropped = content.length - MAX_TOOL_RESULT_CHARS;
  return (
    content.slice(0, MAX_TOOL_RESULT_CHARS) +
    `\n…[truncated ${dropped} characters of tool output]`
  );
}

/**
 * Base activity names.
 *
 * Registered — and called — with the agent name appended, so each runner owns
 * its own pair. See {@link activityNamesFor}.
 */
export const ACTIVITY_INVOKE_MODEL = 'diagrid.mastra.invokeModel';
export const ACTIVITY_INVOKE_TOOL = 'diagrid.mastra.invokeTool';

/**
 * The activity names a given agent registers and calls.
 *
 * Scoping matters because two runners in one process share a Dapr sidecar and
 * each opens its own worker stream. Registered under identical literal names,
 * either connection can service either runner's work items — so runner B's
 * tools could answer runner A's turn, and the result would be checkpointed as
 * authoritative. The workflow name was already per-agent; this closes the same
 * hole for activities.
 */
export function activityNamesFor(agentName: string): {
  model: string;
  tool: string;
} {
  return {
    model: `${ACTIVITY_INVOKE_MODEL}.${agentName}`,
    tool: `${ACTIVITY_INVOKE_TOOL}.${agentName}`,
  };
}

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

/**
 * The tool invokers an activity needs, keyed by the `tools` record key.
 *
 * Passed in per call rather than held in a module global. An earlier version
 * kept `registries` at module scope, which meant two runners in one process
 * clobbered each other: starting runner B wiped runner A's invokers while A's
 * runtime was still serving, so A's next model activity used B's agent — and the
 * answer was checkpointed as authoritative. `shutdown()` did the same to a
 * still-running peer, on the normal path rather than on misuse.
 *
 * The global was justified by "the orchestrator cannot close over the live
 * Agent". True — but only the *orchestrator* is replayed. Activities are
 * invoked, not replayed, and `registerActivityWithName` accepts a closure, so
 * the runner binds its own invokers there and nothing is shared.
 */
export type ToolInvokers = ReadonlyMap<string, ToolInvoker>;

/**
 * Activity: one model call.
 *
 * Runs outside the orchestrator so it may be non-deterministic, and is
 * checkpointed on completion so a replay never re-issues the call.
 */
export async function invokeModelActivity(
  _ctx: WorkflowActivityContext,
  rawInput: unknown,
  invoker: ModelInvoker
): Promise<InvokeModelOutput> {
  const input = invokeModelInputSchema.parse(rawInput);
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
  rawInput: unknown,
  invokers: ToolInvokers
): Promise<InvokeToolOutput> {
  const input = invokeToolInputSchema.parse(rawInput);
  const invoker = invokers.get(input.toolName);

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
 * Call an activity, retrying transient failures with durable backoff.
 *
 * A delegated generator (`yield*`), so every activity call and every backoff
 * timer is yielded from the orchestrator itself and replay ordering stays
 * deterministic.
 *
 * This stands in for a Dapr activity `RetryPolicy`, which the JS SDK does not
 * have: neither `@dapr/dapr@3.18` nor `@dapr/durabletask-js@1.0` accepts one —
 * `callActivity(activity, input)` is the whole signature. (Python's
 * `dapr-ext-workflow` does.) Durability is unaffected: attempts and timers are
 * checkpointed workflow actions, so a process killed between attempt 2 and 3
 * resumes at attempt 3. The delay comes from `getCurrentUtcDateTime()`, which is
 * replay-stable; `Date.now()` here would corrupt replay.
 *
 * Callers parse the result *outside* the retry region on purpose. A schema
 * mismatch — the rolling-deploy case the schemas exist for — is deterministic,
 * so retrying it only burns two backoff timers before handing the model a
 * serialized ZodError.
 *
 * TODO(mastra-adapter): delete this when the JS SDK gains a native RetryPolicy.
 */
function* callActivityWithRetry(
  ctx: WorkflowContext,
  activity: string,
  activityInput: unknown
): Generator<unknown, { result?: unknown; failure?: string }, unknown> {
  let lastFailure: string | undefined;

  for (let attempt = 1; attempt <= ACTIVITY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return { result: yield ctx.callActivity(activity, activityInput) };
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);

      if (attempt < ACTIVITY_MAX_ATTEMPTS) {
        const delayMs = ACTIVITY_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        yield ctx.createTimer(
          new Date(ctx.getCurrentUtcDateTime().getTime() + delayMs)
        );
      }
    }
  }

  return { failure: lastFailure ?? 'unknown error' };
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
  // Absent only for an instance scheduled before activity names were scoped.
  // The unscoped fallback is a defined failure, not a rescue: no runner
  // registers those names any more, so the call comes back as
  // "Activity function ... is not registered", is retried, and the turn ends
  // FAILED with that message. That is the point — a named, loud failure
  // beats calling `ctx.callActivity(undefined, ...)`.
  const activities = input.activityNames ?? {
    model: ACTIVITY_INVOKE_MODEL,
    tool: ACTIVITY_INVOKE_TOOL,
  };

  const messages: Message[] = [
    ...input.messages,
    { role: 'user', content: input.prompt },
  ];

  let iteration = 0;

  while (iteration < input.maxIterations) {
    // Retried like the tool call below. Without this, a single 429 or dropped
    // socket failed the instance outright and discarded the entire transcript,
    // including iterations whose model calls were already paid for.
    const modelAttempt = yield* callActivityWithRetry(ctx, activities.model, {
      messages,
      iteration,
      threadId: input.threadId,
    });
    iteration += 1;

    if (modelAttempt.failure !== undefined) {
      // Retries exhausted. Return FAILED with the transcript intact, so the
      // caller keeps the partial turn instead of losing it with the instance.
      return {
        text: '',
        messages,
        iterations: iteration,
        status: WorkflowStatus.FAILED,
        error: `model call failed after ${ACTIVITY_MAX_ATTEMPTS} attempts: ${modelAttempt.failure}`,
      };
    }

    // Parsed outside the retry region: a schema mismatch is deterministic.
    const modelOutput = invokeModelOutputSchema.parse(modelAttempt.result);

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

      // Retry a failed tool in place, without involving the model.
      const toolAttempt = yield* callActivityWithRetry(
        ctx,
        activities.tool,
        activityInput
      );

      if (toolAttempt.failure !== undefined) {
        // Retries exhausted. Report it to the model as a tool error rather than
        // failing the turn: a tool that is down is something the agent may be
        // able to work around or explain, and losing the whole conversation is
        // strictly worse.
        messages.push({
          role: 'tool',
          content: `tool failed after ${ACTIVITY_MAX_ATTEMPTS} attempts: ${toolAttempt.failure}`,
          toolCallId: call.id,
        });
        continue;
      }

      // Parsed outside the retry region: a schema mismatch between the
      // orchestrator and a differently-versioned activity worker is
      // deterministic, so retrying it only wastes two backoff timers.
      const toolOutput = invokeToolOutputSchema.parse(toolAttempt.result);

      messages.push({
        role: 'tool',
        content: capToolResult(toolOutput.error ?? toolOutput.result),
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

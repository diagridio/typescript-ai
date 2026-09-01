// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The durable agent loop.
 *
 * The orchestrator is a plain generator, so it can be driven step by step
 * without a sidecar: each `yield` is an activity call and the value we send
 * back is what Dapr would have replayed from history. That makes the control
 * flow — including the failure and loop-cap paths — fully unit-testable, which
 * matters because those are exactly the paths a live e2e run rarely reaches.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { WorkflowContext } from '@diagrid/agent-core';
import {
  ACTIVITY_INVOKE_MODEL,
  ACTIVITY_INVOKE_TOOL,
  ACTIVITY_RETRY_BASE_DELAY_MS,
  agentWorkflow,
  invokeModelActivity,
  invokeToolActivity,
  WorkflowStatus,
  type AgentWorkflowOutput,
  MAX_TOOL_RESULT_CHARS,
  type InvokeToolInput,
  type ToolInvoker,
} from '@diagrid/agent-core';

interface ActivityCall {
  readonly name: string;
  readonly input: unknown;
}

/**
 * Run the orchestrator against scripted activity results.
 *
 * `results` are consumed in order, mirroring the sequence Dapr would replay.
 */
/** The routing `schedule()` adds; tests should not have to repeat it. */
const TEST_ACTIVITIES = {
  model: ACTIVITY_INVOKE_MODEL,
  tool: ACTIVITY_INVOKE_TOOL,
} as const;

async function runWorkflow(
  input: Record<string, unknown>,
  results: readonly unknown[],
  // Pass your own array to inspect the calls of a run that *rejects* — the
  // return value is unavailable then, and "how far did it get" is exactly the
  // question a failure test needs to answer.
  calls: ActivityCall[] = []
): Promise<{ output: AgentWorkflowOutput; calls: ActivityCall[] }> {
  // `activityNames` is required on the scheduled input, so default it here
  // rather than in every case. A test that cares passes its own.
  const scheduled = { activityNames: TEST_ACTIVITIES, ...input };
  const ctx = {
    callActivity: (activity: unknown, activityInput?: unknown) => {
      calls.push({ name: String(activity), input: activityInput });
      return activityInput;
    },
    // The retry loop schedules durable timers between attempts. The driver
    // records them so a test can assert backoff happened, and resolves them
    // immediately so the suite stays fast.
    createTimer: (fireAt: Date) => {
      calls.push({ name: 'timer', input: fireAt });
      return fireAt;
    },
    getCurrentUtcDateTime: () => new Date('2026-08-12T00:00:00.000Z'),
  } as unknown as WorkflowContext;

  // Driven with `await` because the orchestrator is an `async function*` — which
  // is a hard requirement of Dapr's executor, not a preference. See the note on
  // `agentWorkflow`.
  const generator = agentWorkflow(ctx, scheduled);
  let step = await generator.next();
  let index = 0;

  while (!step.done) {
    if (index >= results.length) {
      throw new Error(
        `Workflow requested activity #${index + 1} but only ${results.length} results were scripted`
      );
    }
    // A backoff timer is not an activity, so it consumes nothing from the
    // script — it just resolves, the way Dapr resolves it after the delay.
    // Without this the next scripted failure would be thrown *at the timer's
    // yield*, which sits inside the retry loop's catch block and so escapes it.
    if (calls.at(-1)?.name === 'timer') {
      step = await generator.next(undefined);
      continue;
    }

    const scripted = results[index];
    index += 1;
    // An `Error` in the script means "this activity failed", which is how Dapr
    // surfaces a failed activity into the generator.
    step =
      scripted instanceof Error
        ? await generator.throw(scripted)
        : await generator.next(scripted);
  }

  return { output: step.value, calls };
}

/**
 * Drive a run that is expected to reject, and hand back what it did first.
 *
 * A rejecting run has no return value to read `calls` from, and threading the
 * out-param through `runWorkflow` by hand is a parameter a future test can
 * forget — silently, because an assertion about what did *not* happen is
 * satisfied by an array nothing ever wrote to. This is the sanctioned path;
 * `runWorkflow`'s third argument exists for it and should not be passed
 * directly.
 */
async function runWorkflowExpectingRejection(
  input: Record<string, unknown>,
  results: readonly unknown[]
): Promise<{ error: unknown; calls: ActivityCall[] }> {
  const calls: ActivityCall[] = [];
  try {
    await runWorkflow(input, results, calls);
  } catch (error) {
    return { error, calls };
  }
  throw new Error('expected the workflow to reject, but it completed');
}

const assistantText = (content: string) => ({
  message: { role: 'assistant', content },
  requiresToolCalls: false,
});

const assistantToolCall = (id: string, name: string, args: string) => ({
  message: {
    role: 'assistant',
    content: '',
    toolCalls: [{ id, name, args }],
  },
  requiresToolCalls: true,
});

/** One model turn asking for several tools at once — the fan-out shape. */
const assistantToolCalls = (
  ...toolCalls: readonly { id: string; name: string; args: string }[]
) => ({
  message: { role: 'assistant', content: '', toolCalls },
  requiresToolCalls: true,
});

describe('agentWorkflow', () => {
  it('completes on the first turn when the model needs no tools', async () => {
    const { output, calls } = await runWorkflow(
      { prompt: 'hello', threadId: 't1' },
      [assistantText('hi there')]
    );

    expect(output.status).toBe(WorkflowStatus.COMPLETED);
    expect(output.text).toBe('hi there');
    expect(output.iterations).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe(ACTIVITY_INVOKE_MODEL);
  });

  it('seeds the transcript with prior messages plus the new prompt', async () => {
    const { output } = await runWorkflow(
      {
        prompt: 'and now?',
        threadId: 't1',
        messages: [{ role: 'user', content: 'earlier' }],
      },
      [assistantText('done')]
    );

    expect(output.messages.map((m) => m.content)).toEqual([
      'earlier',
      'and now?',
      'done',
    ]);
  });

  it('executes tool calls and feeds the results back to the model', async () => {
    const { output, calls } = await runWorkflow(
      { prompt: 'search for X', threadId: 't1' },
      [
        assistantToolCall('call-1', 'searchDocs', '{"query":"X"}'),
        { toolCallId: 'call-1', result: '{"hits":2}' },
        assistantText('I found 2 results.'),
      ]
    );

    expect(calls.map((c) => c.name)).toEqual([
      ACTIVITY_INVOKE_MODEL,
      ACTIVITY_INVOKE_TOOL,
      ACTIVITY_INVOKE_MODEL,
    ]);
    expect(calls[1]?.input).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'searchDocs',
      args: '{"query":"X"}',
      threadId: 't1',
    });
    expect(output.status).toBe(WorkflowStatus.COMPLETED);
    expect(output.messages.at(-2)).toEqual({
      role: 'tool',
      content: '{"hits":2}',
      toolCallId: 'call-1',
    });
  });

  it('runs every tool of a multi-call turn, in the order the model asked', async () => {
    // The fan-out branch. Every other fixture in this file requests exactly one
    // tool, so the `for (const call of toolCalls)` loop has only ever been
    // executed with a single element — which cannot detect a reordering, and
    // leaves the `ctx.whenAll` TODO with nothing to regress against when
    // somebody takes it.
    const { output, calls } = await runWorkflow(
      { prompt: 'compare X and Y', threadId: 't1' },
      [
        assistantToolCalls(
          { id: 'call-1', name: 'searchDocs', args: '{"query":"X"}' },
          { id: 'call-2', name: 'fetchPage', args: '{"url":"Y"}' }
        ),
        { toolCallId: 'call-1', result: '{"hits":2}' },
        { toolCallId: 'call-2', result: '{"body":"Y!"}' },
        assistantText('X has 2 hits; Y says "Y!".'),
      ]
    );

    // Two separate durable activities between the two model calls — not one
    // batched call, and not a silently dropped second tool.
    expect(calls.map((c) => c.name)).toEqual([
      ACTIVITY_INVOKE_MODEL,
      ACTIVITY_INVOKE_TOOL,
      ACTIVITY_INVOKE_TOOL,
      ACTIVITY_INVOKE_MODEL,
    ]);

    // Dispatched in the model's order. Replay re-executes the orchestrator from
    // the top, so a nondeterministic iteration order here would replay as a
    // different history against the same checkpoints.
    expect(
      calls
        .filter((c) => c.name === ACTIVITY_INVOKE_TOOL)
        .map((c) => (c.input as { toolCallId: string }).toolCallId)
    ).toEqual(['call-1', 'call-2']);

    // And both results reach the model, correlated to the right call. This one
    // pins *correlation*, not order — the driver consumes its script by index,
    // so it reads the same either way round. Reordering is caught above.
    expect(output.messages.slice(-3, -1)).toEqual([
      { role: 'tool', content: '{"hits":2}', toolCallId: 'call-1' },
      { role: 'tool', content: '{"body":"Y!"}', toolCallId: 'call-2' },
    ]);
    expect(output.status).toBe(WorkflowStatus.COMPLETED);
    expect(output.iterations).toBe(2);
  });

  it('surfaces a tool error to the model as the tool message', async () => {
    // A failed tool is information for the model, not a workflow failure — the
    // model gets a chance to correct a bad call.
    const { output } = await runWorkflow({ prompt: 'go', threadId: 't1' }, [
      assistantToolCall('call-1', 'searchDocs', '{}'),
      { toolCallId: 'call-1', result: '', error: 'query is required' },
      assistantText('Let me rephrase.'),
    ]);

    expect(output.status).toBe(WorkflowStatus.COMPLETED);
    expect(output.messages.at(-2)?.content).toBe('query is required');
  });

  it('fails the workflow when a ModelInvoker reports .error', async () => {
    // Contract test, not a reproduction: the shipped bridge never sets `.error`
    // — it throws, which is the retry path above. `.error` is the escape hatch
    // for a custom invoker installed via `runner.setModelInvoker()` that wants
    // to end the turn without a retry, so the orchestrator has to honour it.
    const { output } = await runWorkflow({ prompt: 'go', threadId: 't1' }, [
      { message: { role: 'assistant', content: '' }, error: 'rate limited' },
    ]);

    expect(output.status).toBe(WorkflowStatus.FAILED);
    expect(output.error).toBe('rate limited');
    expect(output.text).toBe('');
  });

  it('fails rather than truncating when maxIterations is exhausted', async () => {
    // A runaway agent must not be reported as a completed one: the caller has
    // no other way to tell "the model stopped" from "we stopped it".
    const { output } = await runWorkflow(
      { prompt: 'loop forever', threadId: 't1', maxIterations: 2 },
      [
        assistantToolCall('c1', 'searchDocs', '{}'),
        { toolCallId: 'c1', result: 'x' },
        assistantToolCall('c2', 'searchDocs', '{}'),
        { toolCallId: 'c2', result: 'x' },
      ]
    );

    expect(output.status).toBe(WorkflowStatus.FAILED);
    expect(output.error).toMatch(/exceeded maxIterations \(2\)/);
    expect(output.iterations).toBe(2);
  });

  it('treats an empty toolCalls list as a final answer', async () => {
    const { output, calls } = await runWorkflow(
      { prompt: 'go', threadId: 't1' },
      [
        {
          message: { role: 'assistant', content: 'ok', toolCalls: [] },
          requiresToolCalls: true,
        },
      ]
    );

    expect(calls).toHaveLength(1);
    expect(output.status).toBe(WorkflowStatus.COMPLETED);
  });

  it('rejects malformed workflow input at the boundary', async () => {
    // `rejects` rather than `toThrow`: an async generator surfaces a throw from
    // its body as a rejected promise, not a synchronous exception.
    //
    // Matched on `ZodError` specifically. A bare `toThrow()` is also satisfied
    // by the driver's own script-exhaustion `Error`, so it would pass whether
    // the input was rejected at the boundary or accepted and then run off the
    // end of an empty script — the opposite outcomes this pins.
    await expect(runWorkflow({ threadId: 't1' }, [])).rejects.toThrow(
      z.ZodError
    );
  });

  it('rejects a malformed activity result on replay', async () => {
    // Activity output comes back from the state store, i.e. from outside the
    // process. A schema change that would mis-read an in-flight workflow has
    // to fail here rather than corrupt the transcript.
    const { error, calls } = await runWorkflowExpectingRejection(
      { prompt: 'go', threadId: 't1' },
      [{ nonsense: true }]
    );
    expect(error).toBeInstanceOf(z.ZodError);

    // One dispatch, no timers — the fail-fast property, pinned directly.
    //
    // The `ZodError` check above is what actually catches the parse moving back
    // inside the retry region: the retry region re-yields, the driver runs out
    // of scripted results, and a plain `Error` surfaces instead of a `ZodError`.
    // These two assertions do not detect that mutation on their own — they state
    // the invariant rather than relying on that side effect of the harness.
    expect(calls.filter((c) => c.name === 'timer')).toEqual([]);
    expect(calls.filter((c) => c.name === ACTIVITY_INVOKE_MODEL)).toHaveLength(
      1
    );
  });
});

describe('invokeModelActivity', () => {
  it('delegates to the invoker it is given', async () => {
    const output = await invokeModelActivity(
      {} as never,
      {
        messages: [{ role: 'user', content: 'hi' }],
        iteration: 0,
        threadId: 't1',
      },
      () =>
        Promise.resolve({
          message: { role: 'assistant' as const, content: 'from invoker' },
          requiresToolCalls: false,
        })
    );

    expect(output.message.content).toBe('from invoker');
  });
});

describe('invokeToolActivity', () => {
  const invokers = new Map<string, ToolInvoker>([
    [
      'searchDocs',
      (input: InvokeToolInput) =>
        Promise.resolve({ toolCallId: input.toolCallId, result: '{"hits":1}' }),
    ],
  ]);

  it('delegates to the invoker registered under the tool name', async () => {
    const output = await invokeToolActivity(
      {} as never,
      { toolCallId: 'c1', toolName: 'searchDocs', args: '{}', threadId: 't1' },
      invokers
    );

    expect(output).toEqual({ toolCallId: 'c1', result: '{"hits":1}' });
  });

  it('reports an unknown tool as a tool error, not an activity failure', async () => {
    const output = await invokeToolActivity(
      {} as never,
      { toolCallId: 'c1', toolName: 'ghost', args: '{}', threadId: 't1' },
      invokers
    );

    expect(output.error).toBe('Unknown tool "ghost"');
  });

  it('keeps two invoker maps independent', async () => {
    // The regression the module-level registry caused: a second runner's
    // registration replaced the first's, so agent B answered agent A's turns.
    const other = new Map<string, ToolInvoker>([
      [
        'searchDocs',
        (input: InvokeToolInput) =>
          Promise.resolve({ toolCallId: input.toolCallId, result: 'B' }),
      ],
    ]);
    const call = {
      toolCallId: 'c1',
      toolName: 'searchDocs',
      args: '{}',
      threadId: 't1',
    };

    expect((await invokeToolActivity({} as never, call, invokers)).result).toBe(
      '{"hits":1}'
    );
    expect((await invokeToolActivity({} as never, call, other)).result).toBe(
      'B'
    );
  });
});

describe('what the model activity is sent', () => {
  it('sends exactly the fields the activity schema declares', () => {
    // An exact match, not toMatchObject. Every field here is serialized into
    // workflow history on each iteration and kept for the life of the instance,
    // so a field the activity does not read is not free — `toolNames` was
    // carried as a permanently-empty array until a review noticed, and a subset
    // assertion could never have caught it.
    return runWorkflow({ prompt: 'go', threadId: 't1' }, [
      assistantText('done'),
    ]).then(({ calls }) => {
      expect(Object.keys(calls[0]?.input as object).sort()).toEqual([
        'iteration',
        'messages',
        'threadId',
      ]);
    });
  });
});

describe('the orchestrator is an async generator', () => {
  it('exposes Symbol.asyncIterator, which is what Dapr dispatches on', () => {
    // This assertion exists because every other test in this file passes with a
    // sync `function*` — verified by making the change and re-running. The
    // driver below advances the generator with `.next()` under `await`, and
    // `await` on a non-thenable resolves immediately, so it cannot tell the two
    // apart. Dapr can, and treats a sync generator as a completed workflow that
    // ran no activities:
    //
    //   const isAsyncGenerator = typeof result?.[Symbol.asyncIterator] === 'function';
    //   if (isAsyncGenerator) { await ctx.run(result); }
    //   else { ctx.setComplete(result, ORCHESTRATION_STATUS_COMPLETED); }
    //
    // (@dapr/durabletask-js, worker/orchestration-executor.js)
    const generator = agentWorkflow({} as WorkflowContext, {
      prompt: 'go',
      threadId: 't1',
    });

    expect(
      typeof generator[Symbol.asyncIterator],
      'agentWorkflow is not an async generator — Dapr will mark the workflow ' +
        'COMPLETED without running a single activity. It must be `async function*`.'
    ).toBe('function');
  });
});

describe('activity name scoping', () => {
  it('calls the activity names carried in its own input', async () => {
    // Two runners in one process share a sidecar and register on separate
    // worker streams. Under identical literal names either stream could service
    // the other's work items, answering runner A's turn with runner B's tools.
    const { calls } = await runWorkflow(
      {
        prompt: 'go',
        threadId: 't1',
        activityNames: {
          model: 'diagrid.mastra.invokeModel.agent-a',
          tool: 'diagrid.mastra.invokeTool.agent-a',
        },
      },
      [
        assistantToolCall('c1', 'searchDocs', '{}'),
        { toolCallId: 'c1', result: 'x' },
        assistantText('done'),
      ]
    );

    expect(calls.map((c) => c.name)).toEqual([
      'diagrid.mastra.invokeModel.agent-a',
      'diagrid.mastra.invokeTool.agent-a',
      'diagrid.mastra.invokeModel.agent-a',
    ]);
  });

  it('fails loudly when routing is missing entirely', async () => {
    // Replaces a fallback to unscoped literals. Nothing registers those names,
    // so the fallback only ever spent the retry budget before failing; a schema
    // error names the missing field immediately.
    const ctx = {
      callActivity: () => undefined,
      createTimer: () => undefined,
      getCurrentUtcDateTime: () => new Date(0),
    };
    const generator = agentWorkflow(ctx as unknown as WorkflowContext, {
      prompt: 'go',
      threadId: 't1',
    });

    await expect(generator.next()).rejects.toThrow(/activityNames/);
  });
});

describe('oversized tool results', () => {
  it('truncates a result that would be resent on every later iteration', async () => {
    const huge = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 5_000);
    const { output } = await runWorkflow({ prompt: 'go', threadId: 't1' }, [
      assistantToolCall('c1', 'searchDocs', '{}'),
      { toolCallId: 'c1', result: huge },
      assistantText('done'),
    ]);

    const toolMessage = output.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content.length).toBeLessThan(huge.length);
    expect(toolMessage?.content).toContain('truncated 5000 characters');
  });

  it('truncates an oversized tool *failure* message too', async () => {
    // The failure path is the uncapped one, and it is the likelier offender: a
    // failure message is an activity error, which for an HTTP client routinely
    // embeds a whole response body. It is checkpointed and re-sent on every
    // remaining iteration exactly like a success is, so it needs the same cap.
    const huge = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 5_000);
    const { output } = await runWorkflow({ prompt: 'go', threadId: 't1' }, [
      assistantToolCall('c1', 'searchDocs', '{}'),
      new Error(huge),
      new Error(huge),
      new Error(huge),
      assistantText('gave up on that tool'),
    ]);

    const toolMessage = output.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('tool failed after 3 attempts');
    expect(toolMessage?.content).toContain('truncated');
    expect(toolMessage?.content.length).toBeLessThan(
      MAX_TOOL_RESULT_CHARS + 200
    );
  });

  it('leaves ordinary tool output untouched', async () => {
    const { output } = await runWorkflow({ prompt: 'go', threadId: 't1' }, [
      assistantToolCall('c1', 'searchDocs', '{}'),
      { toolCallId: 'c1', result: '{"hits":2}' },
      assistantText('done'),
    ]);

    expect(output.messages.find((m) => m.role === 'tool')?.content).toBe(
      '{"hits":2}'
    );
  });
});

describe('model call retry', () => {
  it('retries the model activity rather than failing the turn', async () => {
    // Before this, one 429 failed the instance outright and discarded every
    // iteration already paid for.
    const { output, calls } = await runWorkflow(
      { prompt: 'go', threadId: 't1' },
      [new Error('429 rate limited'), assistantText('recovered')]
    );

    expect(output.status).toBe(WorkflowStatus.COMPLETED);
    expect(output.text).toBe('recovered');
    expect(calls.filter((c) => c.name === ACTIVITY_INVOKE_MODEL)).toHaveLength(
      2
    );
  });

  it('keeps the transcript when model retries are exhausted', async () => {
    const { output } = await runWorkflow({ prompt: 'go', threadId: 't1' }, [
      new Error('429'),
      new Error('429'),
      new Error('429'),
    ]);

    expect(output.status).toBe(WorkflowStatus.FAILED);
    expect(output.error).toMatch(/model call failed after 3 attempts/);
    // The partial turn survives rather than being lost with the instance.
    expect(output.messages.length).toBeGreaterThan(0);
  });
});

describe('tool retry', () => {
  // The JS Dapr SDK has no activity RetryPolicy, so the orchestrator retries in
  // place. These pin that behaviour: it is the difference between a rate limit
  // costing a retry and costing a full LLM round trip.
  it('retries a failed tool activity and continues on success', async () => {
    const { output, calls } = await runWorkflow(
      { prompt: 'go', threadId: 't1' },
      [
        assistantToolCall('c1', 'searchDocs', '{}'),
        new Error('ECONNRESET'), // attempt 1 fails
        new Error('ECONNRESET'), // attempt 2 fails
        { toolCallId: 'c1', result: '{"ok":true}' }, // attempt 3 succeeds
        assistantText('done'),
      ]
    );

    expect(output.status).toBe(WorkflowStatus.COMPLETED);
    // Three tool attempts, and the model was called only twice — the retries did
    // not go back through the model.
    const toolAttempts = calls.filter(
      (c) => c.name === ACTIVITY_INVOKE_TOOL
    ).length;
    const modelCalls = calls.filter(
      (c) => c.name === ACTIVITY_INVOKE_MODEL
    ).length;
    expect(toolAttempts).toBe(3);
    expect(modelCalls).toBe(2);
    // Backoff between attempts, as durable timers — asserted by *value*, not
    // just by count. Counting alone survives both determinism corruptions that
    // `callActivityWithRetry` in `packages/core/src/agent/workflow.ts` warns
    // about: swapping `ctx.getCurrentUtcDateTime()` for `Date.now()` (which
    // makes replay diverge) and forcing `delayMs` to 0 (which removes the
    // backoff while keeping the timers). Neither is visible to lint.
    //
    // Derived from the exported constant rather than hardcoded, so tuning the
    // base delay does not require recomputing two ISO strings by hand.
    //
    // It does *not* pin the growth curve. With ACTIVITY_MAX_ATTEMPTS = 3 only
    // two timers ever fire, and `BASE * 2 ** (n - 1)` and `BASE * n` agree on
    // both of them — they first diverge at attempt 3, which never happens.
    // Distinguishing them would need a fourth attempt, so this asserts the two
    // delays that exist and claims nothing about the formula behind them.
    const base = new Date('2026-08-12T00:00:00.000Z').getTime();
    expect(
      calls
        .filter((c) => c.name === 'timer')
        .map((c) => (c.input as Date).toISOString())
    ).toEqual([
      new Date(base + ACTIVITY_RETRY_BASE_DELAY_MS).toISOString(),
      new Date(base + ACTIVITY_RETRY_BASE_DELAY_MS * 2).toISOString(),
    ]);
  });

  it('reports the failure to the model once retries are exhausted', async () => {
    const { output } = await runWorkflow({ prompt: 'go', threadId: 't1' }, [
      assistantToolCall('c1', 'searchDocs', '{}'),
      new Error('still down'),
      new Error('still down'),
      new Error('still down'),
      assistantText('I could not reach that tool.'),
    ]);

    // The turn survives: a permanently broken tool becomes information for the
    // model, not a failed conversation.
    expect(output.status).toBe(WorkflowStatus.COMPLETED);
    expect(output.messages.some((m) => m.content.includes('still down'))).toBe(
      true
    );
    expect(
      output.messages.some((m) => m.content.includes('after 3 attempts'))
    ).toBe(true);
  });
});

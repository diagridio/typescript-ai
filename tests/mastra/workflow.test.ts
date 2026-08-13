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

import { afterEach, describe, expect, it } from 'vitest';

import type { WorkflowContext } from '@diagrid/agent-core';
import {
  ACTIVITY_INVOKE_MODEL,
  ACTIVITY_INVOKE_TOOL,
  agentWorkflow,
  clearRegistries,
  invokeModelActivity,
  invokeToolActivity,
  registeredToolNames,
  registerModelInvoker,
  registerToolInvoker,
  WorkflowStatus,
  type AgentWorkflowOutput,
} from '@diagrid/agent-mastra';

interface ActivityCall {
  readonly name: string;
  readonly input: unknown;
}

/**
 * Run the orchestrator against scripted activity results.
 *
 * `results` are consumed in order, mirroring the sequence Dapr would replay.
 */
async function runWorkflow(
  input: unknown,
  results: readonly unknown[]
): Promise<{ output: AgentWorkflowOutput; calls: ActivityCall[] }> {
  const calls: ActivityCall[] = [];
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
  const generator = agentWorkflow(ctx, input);
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

afterEach(() => {
  clearRegistries();
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

  it('fails the workflow when the model call itself errors', async () => {
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
    await expect(runWorkflow({ threadId: 't1' }, [])).rejects.toThrow();
  });

  it('rejects a malformed activity result on replay', async () => {
    // Activity output comes back from the state store, i.e. from outside the
    // process. A schema change that would mis-read an in-flight workflow has
    // to fail here rather than corrupt the transcript.
    await expect(
      runWorkflow({ prompt: 'go', threadId: 't1' }, [{ nonsense: true }])
    ).rejects.toThrow();
  });
});

describe('invokeModelActivity', () => {
  it('delegates to the registered invoker', async () => {
    registerModelInvoker(() =>
      Promise.resolve({
        message: { role: 'assistant' as const, content: 'from invoker' },
        requiresToolCalls: false,
      })
    );

    const output = await invokeModelActivity({} as never, {
      messages: [{ role: 'user', content: 'hi' }],
      iteration: 0,
      threadId: 't1',
    });

    expect(output.message.content).toBe('from invoker');
  });

  it('fails loudly when nothing is registered', async () => {
    await expect(
      invokeModelActivity({} as never, {
        messages: [],
        iteration: 0,
        threadId: 't1',
      })
    ).rejects.toThrow(/No model invoker registered/);
  });
});

describe('invokeToolActivity', () => {
  it('delegates to the invoker registered under the tool name', async () => {
    registerToolInvoker('searchDocs', (input) =>
      Promise.resolve({ toolCallId: input.toolCallId, result: '{"hits":1}' })
    );

    const output = await invokeToolActivity({} as never, {
      toolCallId: 'c1',
      toolName: 'searchDocs',
      args: '{}',
      threadId: 't1',
    });

    expect(output).toEqual({ toolCallId: 'c1', result: '{"hits":1}' });
  });

  it('reports an unknown tool as a tool error, not an activity failure', async () => {
    const output = await invokeToolActivity({} as never, {
      toolCallId: 'c1',
      toolName: 'ghost',
      args: '{}',
      threadId: 't1',
    });

    expect(output.error).toBe('Unknown tool "ghost"');
  });
});

describe('registries', () => {
  it('reports registered tool names in registration order', () => {
    registerToolInvoker('a', () =>
      Promise.resolve({ toolCallId: '', result: '' })
    );
    registerToolInvoker('b', () =>
      Promise.resolve({ toolCallId: '', result: '' })
    );

    expect(registeredToolNames()).toEqual(['a', 'b']);
  });

  it('clears every registration', () => {
    registerToolInvoker('a', () =>
      Promise.resolve({ toolCallId: '', result: '' })
    );
    clearRegistries();

    expect(registeredToolNames()).toEqual([]);
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
    // Backoff between attempts, as durable timers.
    expect(calls.filter((c) => c.name === 'timer')).toHaveLength(2);
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

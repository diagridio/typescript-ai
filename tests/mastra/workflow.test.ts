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
function runWorkflow(
  input: unknown,
  results: readonly unknown[]
): { output: AgentWorkflowOutput; calls: ActivityCall[] } {
  const calls: ActivityCall[] = [];
  const ctx = {
    callActivity: (activity: unknown, activityInput?: unknown) => {
      calls.push({ name: String(activity), input: activityInput });
      return activityInput;
    },
  } as unknown as WorkflowContext;

  const generator = agentWorkflow(ctx, input);
  let step = generator.next();
  let index = 0;

  while (!step.done) {
    if (index >= results.length) {
      throw new Error(
        `Workflow requested activity #${index + 1} but only ${results.length} results were scripted`
      );
    }
    step = generator.next(results[index]);
    index += 1;
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
  it('completes on the first turn when the model needs no tools', () => {
    const { output, calls } = runWorkflow({ prompt: 'hello', threadId: 't1' }, [
      assistantText('hi there'),
    ]);

    expect(output.status).toBe(WorkflowStatus.COMPLETED);
    expect(output.text).toBe('hi there');
    expect(output.iterations).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe(ACTIVITY_INVOKE_MODEL);
  });

  it('seeds the transcript with prior messages plus the new prompt', () => {
    const { output } = runWorkflow(
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

  it('executes tool calls and feeds the results back to the model', () => {
    const { output, calls } = runWorkflow(
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

  it('surfaces a tool error to the model as the tool message', () => {
    // A failed tool is information for the model, not a workflow failure — the
    // model gets a chance to correct a bad call.
    const { output } = runWorkflow({ prompt: 'go', threadId: 't1' }, [
      assistantToolCall('call-1', 'searchDocs', '{}'),
      { toolCallId: 'call-1', result: '', error: 'query is required' },
      assistantText('Let me rephrase.'),
    ]);

    expect(output.status).toBe(WorkflowStatus.COMPLETED);
    expect(output.messages.at(-2)?.content).toBe('query is required');
  });

  it('fails the workflow when the model call itself errors', () => {
    const { output } = runWorkflow({ prompt: 'go', threadId: 't1' }, [
      { message: { role: 'assistant', content: '' }, error: 'rate limited' },
    ]);

    expect(output.status).toBe(WorkflowStatus.FAILED);
    expect(output.error).toBe('rate limited');
    expect(output.text).toBe('');
  });

  it('fails rather than truncating when maxIterations is exhausted', () => {
    // A runaway agent must not be reported as a completed one: the caller has
    // no other way to tell "the model stopped" from "we stopped it".
    const { output } = runWorkflow(
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

  it('treats an empty toolCalls list as a final answer', () => {
    const { output, calls } = runWorkflow({ prompt: 'go', threadId: 't1' }, [
      {
        message: { role: 'assistant', content: 'ok', toolCalls: [] },
        requiresToolCalls: true,
      },
    ]);

    expect(calls).toHaveLength(1);
    expect(output.status).toBe(WorkflowStatus.COMPLETED);
  });

  it('rejects malformed workflow input at the boundary', () => {
    expect(() => runWorkflow({ threadId: 't1' }, [])).toThrow();
  });

  it('rejects a malformed activity result on replay', () => {
    // Activity output comes back from the state store, i.e. from outside the
    // process. A schema change that would mis-read an in-flight workflow has
    // to fail here rather than corrupt the transcript.
    expect(() =>
      runWorkflow({ prompt: 'go', threadId: 't1' }, [{ nonsense: true }])
    ).toThrow();
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

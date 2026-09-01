// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The Mastra bridge, against a mock model.
 *
 * This file exists because `bridge.ts` shipped at 0% unit coverage, and three of
 * the four correctness bugs found in review lived in it. The only lane that
 * exercised it needed Ollama and a Dapr sidecar, so it ran nightly and behind a
 * PR label — nothing about the bridge gated a pull request.
 *
 * A mock AI SDK v2 model removes both dependencies: these run in milliseconds,
 * with no network and no sidecar, and they pin the invariants that are otherwise
 * only visible by reading Mastra's internals.
 */

import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createModelInvoker,
  createToolInvokers,
  definitionOnlyTools,
  toModelMessages,
  type Message,
} from '@diagrid/agent-mastra';

/**
 * A minimal AI SDK v2 language model.
 *
 * `doGenerate` returns whatever content the test scripts, so a tool call can be
 * provoked without a provider. `specificationVersion: 'v2'` is what Mastra
 * resolves real models to (checked against `agent.getModel()`).
 */
function mockModel(content: unknown[]) {
  const calls: unknown[] = [];
  return {
    calls,
    model: {
      specificationVersion: 'v2',
      provider: 'mock',
      modelId: 'mock-model',
      supportedUrls: {},
      doGenerate: (options: unknown) => {
        calls.push(options);
        return Promise.resolve({
          content,
          finishReason: 'stop',
          usage: { inputTokens: 7, outputTokens: 11, totalTokens: 18 },
          warnings: [],
        });
      },
      doStream: () => Promise.reject(new Error('not used')),
    },
  };
}

/**
 * Build an Agent around the mock model.
 *
 * The cast is the one concession to the mock: `MastraModelConfig` is a union of
 * the four AI SDK spec versions plus Mastra's own router shapes, and a
 * hand-rolled v2 model structurally satisfies what is used at runtime but not
 * the declared union. Casting once here keeps it out of every test.
 */
function agentWith(
  model: ReturnType<typeof mockModel>['model'],
  tools?: Record<string, unknown>
): Agent {
  return new Agent({
    id: 'a',
    name: 'a',
    instructions: 'x',
    model: model as never,
    ...(tools ? { tools: tools as never } : {}),
  });
}

const weatherArgs = { city: 'Copenhagen' };

/** A tool that records whether its body ran. */
function trackedTool(id: string) {
  const state = { executed: 0 };
  const tool = createTool({
    id,
    description: 'Get the weather for a city.',
    inputSchema: z.object({ city: z.string() }),
    outputSchema: z.object({ summary: z.string() }),
    execute: ({ city }) => {
      state.executed += 1;
      return Promise.resolve({ summary: `sunny in ${city}` });
    },
  });
  return { tool, state };
}

const toolCallContent = (toolName: string) => [
  {
    type: 'tool-call' as const,
    toolCallId: 'call-1',
    toolName,
    input: JSON.stringify(weatherArgs),
  },
];

describe('definitionOnlyTools', () => {
  it('strips execute while keeping the schema and description', async () => {
    const { tool } = trackedTool('getWeather');
    const stripped = await definitionOnlyTools({ tools: { getWeather: tool } });

    expect(stripped['getWeather']).toBeDefined();
    expect(stripped['getWeather']?.execute).toBeUndefined();
    expect(stripped['getWeather']?.description).toBe(
      'Get the weather for a city.'
    );
    expect(stripped['getWeather']?.inputSchema).toBeDefined();
  });
});

describe('the measurement the bridge header reports', () => {
  it('executes the tool body when the agent keeps its own executable tools', async () => {
    // The positive control for the comparison documented at the top of
    // bridge.ts. Without it, the sibling assertion (`clientTools` -> 0
    // executions) cannot distinguish "the mitigation works" from "this mock
    // harness never executes tool bodies at all", and the header's claim to
    // have *measured* both rows is only half-backed.
    //
    // This calls Mastra directly rather than through createModelInvoker,
    // because createModelInvoker always strips execute first — which is the
    // very behaviour under test.
    const { tool, state } = trackedTool('getWeather');
    const { model } = mockModel(toolCallContent('getWeather'));
    const agent = agentWith(model, { getWeather: tool });

    await agent.generate('weather?', { maxSteps: 1 });

    expect(
      state.executed,
      'Mastra did not execute an agent-level tool — the bridge header claims ' +
        'it does, and that claim is why clientTools exists'
    ).toBe(1);
  });
});

describe('createModelInvoker', () => {
  it('does not let Mastra execute the tool body', async () => {
    // The invariant the whole `clientTools` design exists for. If Mastra runs
    // the tool inside generate(), it runs outside any checkpointed activity —
    // and the orchestrator schedules invokeTool for the same call anyway, so the
    // tool executes twice, once durably and once not.
    const { tool, state } = trackedTool('getWeather');
    const { model } = mockModel(toolCallContent('getWeather'));
    const agent = agentWith(model, { getWeather: tool });

    const output = await createModelInvoker(agent)({
      messages: [{ role: 'user', content: 'weather?' }],
      iteration: 0,
      threadId: 't1',
    });

    expect(state.executed).toBe(0);
    expect(output.requiresToolCalls).toBe(true);
  });

  it('does not cache a failed listTools() forever', async () => {
    // `listTools()` may be backed by an MCP client, so it can fail transiently.
    // The invoker memoises it — correctly, it is one round trip per turn instead
    // of one per iteration — but memoising the *rejection* turns a blip on the
    // first call of a runner's lifetime into a permanent outage for that runner,
    // because the invoker is cached per runner and outlives the turn. It also
    // silently defeats the activity retry: all three attempts would await the
    // same already-settled rejection, spending two backoff timers on nothing.
    const { model } = mockModel([{ type: 'text', text: 'done' }]);
    let attempts = 0;
    const agent = {
      name: 'flaky-tools',
      generate: (...args: unknown[]) =>
        (
          agentWith(model) as unknown as {
            generate: (...a: unknown[]) => unknown;
          }
        ).generate(...args),
      listTools: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error('MCP client unreachable (transient)'))
          : Promise.resolve({});
      },
    } as unknown as Parameters<typeof createModelInvoker>[0];

    const invoke = createModelInvoker(agent);
    const input = {
      messages: [{ role: 'user' as const, content: 'hi' }],
      iteration: 0,
      threadId: 't1',
    };

    await expect(invoke(input)).rejects.toThrow('MCP client unreachable');

    // The next call retries the read rather than replaying the rejection.
    const output = await invoke(input);
    expect(output.message.content).toBe('done');
    expect(attempts).toBe(2);
  });

  it('asks Mastra for exactly one step', async () => {
    // Half of this file's central invariant. `maxSteps: 1` is what keeps the
    // loop in the workflow — with more, Mastra would run its own iterations
    // outside any checkpointed activity — and nothing observed what
    // `createModelInvoker` actually sends, so the 30-line "do not simplify
    // this" argument at the top of bridge.ts was enforced only by prose.
    // Changing it to 10 passed the entire gate.
    //
    // Spied on `generate`, not on the model: `maxSteps` is a Mastra-level loop
    // control and never reaches `doGenerate`, so `mockModel`'s recorded options
    // cannot see it.
    const { model } = mockModel([{ type: 'text', text: 'done' }]);
    const agent = agentWith(model);
    const sent: Record<string, unknown>[] = [];
    const realGenerate = agent.generate.bind(agent);
    (agent as unknown as { generate: unknown }).generate = (
      messages: unknown,
      options: Record<string, unknown>
    ) => {
      sent.push(options);
      return (realGenerate as (m: unknown, o: unknown) => unknown)(
        messages,
        options
      );
    };

    await createModelInvoker(agent)({
      messages: [{ role: 'user', content: 'hi' }],
      iteration: 0,
      threadId: 't1',
    });

    expect(sent[0]?.['maxSteps']).toBe(1);
  });

  it('unwraps the payload of a tool call', async () => {
    // Mastra nests these under `payload`, not flat. Reading them flat yields an
    // empty tool name, which the workflow then reports as "Unknown tool".
    const { tool } = trackedTool('getWeather');
    const { model } = mockModel(toolCallContent('getWeather'));
    const agent = agentWith(model, { getWeather: tool });

    const output = await createModelInvoker(agent)({
      messages: [{ role: 'user', content: 'weather?' }],
      iteration: 0,
      threadId: 't1',
    });

    expect(output.message.toolCalls).toHaveLength(1);
    expect(output.message.toolCalls?.[0]?.name).toBe('getWeather');
    expect(JSON.parse(output.message.toolCalls?.[0]?.args ?? '{}')).toEqual(
      weatherArgs
    );
  });

  it('sends the transcript once, without duplicating the last tool result', async () => {
    // The bug: the last message was used as the prompt *and* left in context.
    // From iteration 2 the transcript ends with a tool result, so the model saw
    // its own tool output again as a user turn.
    const { model, calls } = mockModel([{ type: 'text', text: 'done' }]);
    const agent = agentWith(model);

    const transcript: Message[] = [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call-1',
            name: 'getWeather',
            args: JSON.stringify(weatherArgs),
          },
        ],
      },
      { role: 'tool', content: '{"summary":"sunny"}', toolCallId: 'call-1' },
    ];

    await createModelInvoker(agent)({
      messages: transcript,
      iteration: 1,
      threadId: 't1',
    });

    const prompt = (calls[0] as { prompt: { role: string }[] }).prompt;
    const userTurns = prompt.filter((m) => m.role === 'user');
    const toolTurns = prompt.filter((m) => m.role === 'tool');

    expect(userTurns).toHaveLength(1);
    expect(toolTurns).toHaveLength(1);
    expect(JSON.stringify(userTurns[0])).not.toContain('sunny');
  });

  it('maps AI SDK token usage onto the workflow shape', async () => {
    const { model } = mockModel([{ type: 'text', text: 'hi' }]);
    const agent = agentWith(model);

    const output = await createModelInvoker(agent)({
      messages: [{ role: 'user', content: 'hi' }],
      iteration: 0,
      threadId: 't1',
    });

    expect(output.message.content).toBe('hi');
    expect(output.requiresToolCalls).toBe(false);
    expect(output.usage?.promptTokens).toBe(7);
    expect(output.usage?.completionTokens).toBe(11);
  });

  it('rejects an object that is not a Mastra agent', () => {
    expect(() => createModelInvoker({ name: 'nope' })).toThrow(
      /no generate\(\) method/
    );
  });
});

describe('createToolInvokers', () => {
  it('keys invokers by the tools record key, not tool.id', async () => {
    // Mastra's listClientTools iterates Object.entries(tools), so the record key
    // is the name the model uses. Keying by `tool.id` made every call with a
    // differing id miss, and "Unknown tool" was checkpointed as a success.
    const { tool } = trackedTool('lookup_order_status');
    const invokers = await createToolInvokers({
      tools: { lookupOrder: tool },
    });

    expect([...invokers.keys()]).toEqual(['lookupOrder']);
  });

  it('validates arguments and runs the tool body', async () => {
    const { tool, state } = trackedTool('getWeather');
    const invokers = await createToolInvokers({ tools: { getWeather: tool } });

    const output = await invokers.get('getWeather')!({
      toolCallId: 'c1',
      toolName: 'getWeather',
      args: JSON.stringify(weatherArgs),
      threadId: 't1',
    });

    expect(state.executed).toBe(1);
    expect(JSON.parse(output.result)).toEqual({
      summary: 'sunny in Copenhagen',
    });
  });

  it('returns bad arguments as a tool error instead of throwing', async () => {
    // Retrying cannot fix what the model got wrong, so this must not reach the
    // orchestrator's retry path.
    const { tool, state } = trackedTool('getWeather');
    const invokers = await createToolInvokers({ tools: { getWeather: tool } });

    const output = await invokers.get('getWeather')!({
      toolCallId: 'c1',
      toolName: 'getWeather',
      args: '{"city":42}',
      threadId: 't1',
    });

    expect(output.error).toMatch(/invalid arguments/);
    expect(state.executed).toBe(0);
  });

  it('rethrows a tool body failure so the orchestrator can retry it', async () => {
    const flaky = createTool({
      id: 'flaky',
      description: 'fails',
      inputSchema: z.object({}),
      execute: () => Promise.reject(new Error('ECONNRESET')),
    });
    const invokers = await createToolInvokers({ tools: { flaky } });

    await expect(
      invokers.get('flaky')!({
        toolCallId: 'c1',
        toolName: 'flaky',
        args: '{}',
        threadId: 't1',
      })
    ).rejects.toThrow('ECONNRESET');
  });

  it('skips tools with no execute body', async () => {
    const definitionOnly = createTool({
      id: 'noop',
      description: 'no body',
      inputSchema: z.object({}),
    });
    const invokers = await createToolInvokers({
      tools: { noop: definitionOnly },
    });

    // Left unregistered so the activity reports an honest "Unknown tool".
    expect(invokers.size).toBe(0);
  });

  it('drops __proto__ from schema-less tool arguments', async () => {
    // Tool arguments originate from the model, which is untrusted the moment a
    // retrieved document can influence it. A tool without a Zod schema receives
    // this object directly, and a body doing Object.assign(defaults, args) would
    // turn an own __proto__ into prototype pollution.
    let received: Record<string, unknown> | undefined;
    const schemaless = {
      id: 'raw',
      description: 'no schema',
      execute: (input: unknown) => {
        received = input as Record<string, unknown>;
        return Promise.resolve({ ok: true });
      },
    };
    const invokers = await createToolInvokers({ tools: { raw: schemaless } });

    await invokers.get('raw')!({
      toolCallId: 'c1',
      toolName: 'raw',
      args: '{"cmd":"x","__proto__":{"polluted":true},"constructor":{"y":1}}',
      threadId: 't1',
    });

    expect(Object.keys(received ?? {})).toEqual(['cmd']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('toModelMessages', () => {
  it('renders a tool result with the name recovered from its call', () => {
    // The flat transcript shape carries only toolCallId, but an AI SDK tool
    // message needs the tool name, so it is looked up from the preceding call.
    const converted = toModelMessages([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'getWeather', args: '{}' }],
      },
      { role: 'tool', content: '{"summary":"sunny"}', toolCallId: 'c1' },
    ]);

    const toolMessage = converted.at(-1) as {
      content: { toolName: string; toolCallId: string }[];
    };
    expect(toolMessage.content[0]?.toolName).toBe('getWeather');
    expect(toolMessage.content[0]?.toolCallId).toBe('c1');
  });

  it('drops system messages, which the agent instructions already carry', () => {
    const converted = toModelMessages([
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hi' },
    ]);

    expect(converted).toHaveLength(1);
    expect(converted[0]).toEqual({ role: 'user', content: 'hi' });
  });
});

describe('tools with no inputSchema', () => {
  /**
   * Capture this tool's warnings for the duration of one call.
   *
   * Filtered by tool name on purpose. `process.emitWarning` dispatches on a
   * later tick, so a warning emitted by an earlier test in this file lands
   * inside this listener's window — an unfiltered count is flaky, and was.
   */
  async function warningsFor(
    toolName: string,
    run: () => Promise<unknown>
  ): Promise<string[]> {
    const seen: string[] = [];
    const listener = (warning: Error) => {
      if (
        warning.name === 'DiagridUnvalidatedToolArgs' &&
        warning.message.includes(`"${toolName}"`)
      ) {
        seen.push(warning.message);
      }
    };
    process.on('warning', listener);
    try {
      await run();
      // `process.emitWarning` dispatches on the next tick.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', listener);
    }
    return seen;
  }

  it('warns at registration, not at the first call', async () => {
    // The operator should learn about an unvalidated tool when the process
    // starts, not the first time a model happens to call it — by then the
    // arguments have already reached the body.
    const schemaless = {
      id: 'unvalidatedProbe',
      description: 'no schema',
      execute: () => Promise.resolve({ ok: true }),
    };

    const warnings = await warningsFor('unvalidatedProbe', () =>
      createToolInvokers({ tools: { unvalidatedProbe: schemaless } })
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('unvalidated');
  });

  it('stays quiet for a tool that has a schema', async () => {
    const { tool } = trackedTool('getWeather');

    const warnings = await warningsFor('getWeather', () =>
      createToolInvokers({ tools: { getWeather: tool } })
    );

    expect(warnings).toEqual([]);
  });
});

describe('prototype pollution at depth', () => {
  it('strips __proto__ nested inside objects and arrays', async () => {
    // The payload is a raw JSON string on purpose, and the reason is the whole
    // point of this test. Writing it as an object literal —
    // `{ inner: { __proto__: {...}, keep: 1 } }` — does not produce the attack:
    // `__proto__:` in a literal is a *prototype assignment*, not an own
    // property, so JSON.stringify emits `{"inner":{"keep":1}}` with the key
    // already gone. A test built that way passes with the reviver deleted,
    // which is exactly what an earlier version of this test did.
    //
    // Only a string can carry an own `"__proto__"` through to JSON.parse — and
    // a string is what a tool call actually arrives as.
    let received: Record<string, unknown> | undefined;
    const schemaless = {
      id: 'raw',
      description: 'no schema',
      execute: (input: unknown) => {
        received = input as Record<string, unknown>;
        return Promise.resolve({ ok: true });
      },
    };
    const invokers = await createToolInvokers({ tools: { raw: schemaless } });

    await invokers.get('raw')!({
      toolCallId: 'c1',
      toolName: 'raw',
      args:
        '{"outer":{"inner":{"__proto__":{"polluted":true},"keep":1}},' +
        '"list":[{"__proto__":{"polluted":true},"ok":2}]}',
      threadId: 't1',
    });

    // Own keys at depth, not global pollution. JSON.parse builds objects with
    // CreateDataProperty, so it never writes through to Object.prototype on its
    // own — asserting the global stayed clean would pass for any input at all.
    // The real damage happens later, when a tool body merges these into its
    // defaults; what has to be true here is that the key is simply not present.
    const outer = received?.['outer'] as { inner: Record<string, unknown> };
    const list = received?.['list'] as Record<string, unknown>[];

    expect(Object.keys(outer.inner)).toEqual(['keep']);
    expect(Object.keys(list[0] ?? {})).toEqual(['ok']);
  });
});

describe('a tool runs exactly once across both phases', () => {
  it('is not executed by the model call and is executed by the tool call', async () => {
    // The two halves of this invariant were proven on two separate tool
    // instances, so nothing ruled out "0 then 0" or "1 then 2". One tool, both
    // phases, counted end to end.
    const { tool, state } = trackedTool('getWeather');
    const { model } = mockModel(toolCallContent('getWeather'));
    const agent = agentWith(model, { getWeather: tool });

    await createModelInvoker(agent)({
      messages: [{ role: 'user', content: 'weather?' }],
      iteration: 0,
      threadId: 't1',
    });

    expect(state.executed, 'the model phase executed the tool body').toBe(0);

    const invokers = await createToolInvokers(agent);
    await invokers.get('getWeather')!({
      toolCallId: 'call-1',
      toolName: 'getWeather',
      args: JSON.stringify(weatherArgs),
      threadId: 't1',
    });

    expect(
      state.executed,
      'the tool ran a number of times other than once across the whole turn'
    ).toBe(1);
  });
});

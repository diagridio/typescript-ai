// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Regression: map a **real** `@mastra/core` Agent, not a fixture.
 *
 * Every other mapper test uses plain objects shaped like an agent, which keeps
 * the unit suite free of the framework. That is the right default — but it has
 * one blind spot, and this file exists because that blind spot bit us.
 *
 * A real `Agent` instance keeps its configuration private: `agent.instructions`
 * and `agent.tools` are `undefined`, and the values are only reachable through
 * `getInstructions()` and `listTools()` (the latter async). The mapper
 * originally read the plain properties, so it passed every fixture-based test
 * while reporting empty instructions, zero tools and an `unknown` model for
 * every real agent. Running `examples/mastra/inspect-agent.ts` is what surfaced
 * it.
 *
 * So: one test against the genuine class, covering exactly the fields that only
 * a real instance can get wrong.
 */

import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MastraAgentMapper } from '@diagrid/agent-mastra';

const mapper = new MastraAgentMapper();

const lookupOrder = createTool({
  id: 'lookupOrder',
  description: 'Look up an order by id.',
  inputSchema: z.object({ orderId: z.string() }),
  outputSchema: z.object({ status: z.string() }),
  execute: () => Promise.resolve({ status: 'shipped' }),
});

function realAgent() {
  return new Agent({
    id: 'support-agent',
    name: 'support-agent',
    instructions: 'You help customers with billing questions.',
    // Mastra's model-router magic string — the form its own docs lead with.
    model: 'openai/gpt-4o-mini',
    tools: { lookupOrder },
  });
}

describe('MastraAgentMapper against a real Agent instance', () => {
  it('reads instructions through the class accessor', async () => {
    // `agent.instructions` is undefined on a real instance; only
    // `getInstructions()` returns it.
    const record = await mapper.mapAgentMetadata(realAgent());

    expect(record.agent.instructions).toEqual([
      'You help customers with billing questions.',
    ]);
    expect(record.agent.systemPrompt).toBe(
      'You help customers with billing questions.'
    );
  });

  it('reads tools through the async class accessor', async () => {
    // `agent.tools` is undefined; `listTools()` returns a Promise. This is the
    // reason `mapAgentMetadata` is async at all.
    const record = await mapper.mapAgentMetadata(realAgent());

    expect(record.tools.map((t) => t.name)).toEqual(['lookupOrder']);
    expect(record.tools[0]?.description).toBe('Look up an order by id.');

    const args: unknown = JSON.parse(record.tools[0]?.args ?? '{}');
    expect(args).toMatchObject({
      type: 'object',
      properties: { orderId: { type: 'string' } },
    });
  });

  it('resolves the model-router magic string', async () => {
    const record = await mapper.mapAgentMetadata(realAgent());

    expect(record.llm.provider).toBe('openai');
    expect(record.llm.model).toBe('gpt-4o-mini');
  });

  it('still derives the canonical workflow name', async () => {
    const record = await mapper.mapAgentMetadata(realAgent(), {
      name: 'support-agent',
    });

    expect(record.workflowName).toBe('dapr.mastra.SupportAgent.workflow');
  });

  it('resolves an OpenAI-compatible endpoint config', async () => {
    // How you point a real agent at Ollama — and what the e2e lane uses.
    const agent = new Agent({
      id: 'local-agent',
      name: 'local-agent',
      instructions: 'Answer briefly.',
      model: { id: 'ollama/qwen3:0.6b', url: 'http://localhost:11434/v1' },
    });

    const record = await mapper.mapAgentMetadata(agent);

    expect(record.llm.provider).toBe('ollama');
    expect(record.llm.model).toBe('qwen3:0.6b');
    expect(record.llm.baseUrl).toBe('http://localhost:11434/v1');
  });
});

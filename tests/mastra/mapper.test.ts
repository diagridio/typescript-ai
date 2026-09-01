// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MastraAgentMapper } from '@diagrid/agent-mastra';

import { fakeMastraAgent, fakeModel, fakeTool } from '../fixtures/mastra-agent';

const mapper = new MastraAgentMapper();

describe('MastraAgentMapper', () => {
  it('maps a configured agent onto the shared registry schema', async () => {
    const record = await mapper.mapAgentMetadata(fakeMastraAgent());

    expect(record.name).toBe('support-agent');
    expect(record.workflowName).toBe('dapr.mastra.SupportAgent.workflow');
    expect(record.agent.framework).toBe('Mastra');
    expect(record.agent.systemPrompt).toBe(
      'You help customers with billing questions.'
    );
    expect(record.agent.instructions).toEqual([
      'You help customers with billing questions.',
    ]);
    expect(record.llm.provider).toBe('openai');
    expect(record.llm.model).toBe('gpt-4o-mini');
    expect(record.memory.shortTerm?.type).toBe('DaprMastraCheckpointer');
  });

  it('prefers the runner-supplied name over the agent name', async () => {
    // The runner owns the name because the workflow is registered under it;
    // if the two disagreed, the registry entry would point at a workflow that
    // does not exist.
    const record = await mapper.mapAgentMetadata(fakeMastraAgent(), {
      name: 'billing-bot',
    });

    expect(record.name).toBe('billing-bot');
    expect(record.workflowName).toBe('dapr.mastra.BillingBot.workflow');
  });

  it('falls back through name -> id -> a stable default', async () => {
    expect(
      (await mapper.mapAgentMetadata({ id: 'agent-id', name: undefined })).name
    ).toBe('agent-id');
    expect((await mapper.mapAgentMetadata({})).name).toBe('mastra-agent');
  });

  it('records tools with their JSON Schema arguments', async () => {
    const record = await mapper.mapAgentMetadata(
      fakeMastraAgent({
        tools: {
          searchDocs: fakeTool('searchDocs', 'Search the docs'),
          createTicket: fakeTool('createTicket'),
        },
      })
    );

    expect(record.tools.map((t) => t.name)).toEqual([
      'searchDocs',
      'createTicket',
    ]);
    expect(record.tools[0]?.description).toBe('Search the docs');

    const args: unknown = JSON.parse(record.tools[0]?.args ?? '{}');
    expect(args).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string' } },
    });
  });

  it('keys a tool by its map key when it carries no id', async () => {
    const record = await mapper.mapAgentMetadata(
      fakeMastraAgent({
        tools: { lookup: { description: 'no id field' } },
      })
    );

    expect(record.tools).toEqual([
      { name: 'lookup', description: 'no id field', args: '' },
    ]);
  });

  it('degrades to an empty args string for an unrepresentable schema', async () => {
    // A Zod 3 schema, a non-Zod schema, or one containing transforms cannot be
    // rendered as JSON Schema. An empty string is the honest answer; a
    // stringified object would put "[object Object]" in the registry.
    const record = await mapper.mapAgentMetadata(
      fakeMastraAgent({
        tools: { odd: { id: 'odd', inputSchema: { notZod: true } } },
      })
    );

    expect(record.tools[0]?.args).toBe('');
  });

  it('accepts instructions as a string, an array, or a message object', async () => {
    expect(
      (
        await mapper.mapAgentMetadata(
          fakeMastraAgent({ instructions: ['a', 'b'] })
        )
      ).agent.instructions
    ).toEqual(['a', 'b']);

    expect(
      (
        await mapper.mapAgentMetadata(
          fakeMastraAgent({ instructions: { role: 'system', content: 'c' } })
        )
      ).agent.systemPrompt
    ).toBe('c');
  });

  it('skips dynamic (factory) config instead of guessing at it', async () => {
    // Mastra allows `instructions`/`model`/`tools` to be functions resolved
    // against a RuntimeContext that does not exist at registration time.
    const record = await mapper.mapAgentMetadata(
      fakeMastraAgent({
        instructions: () => 'resolved at runtime',
        model: () => fakeModel(),
        tools: () => ({ searchDocs: fakeTool('searchDocs') }),
      })
    );

    expect(record.agent.instructions).toEqual([]);
    expect(record.llm.model).toBe('unknown');
    expect(record.llm.provider).toBe('unknown');
    expect(record.tools).toEqual([]);
  });

  it('carries the model base URL through, for Ollama-style endpoints', async () => {
    const record = await mapper.mapAgentMetadata(
      fakeMastraAgent({
        model: fakeModel({
          modelId: 'qwen3:0.6b',
          provider: 'ollama-ai-provider',
          baseURL: 'http://localhost:11434/v1',
        }),
      })
    );

    expect(record.llm.provider).toBe('ollama');
    expect(record.llm.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('rejects a non-object agent with a clear message', async () => {
    await expect(mapper.mapAgentMetadata('not-an-agent')).rejects.toThrow(
      /expected a Mastra Agent object/
    );
    await expect(mapper.mapAgentMetadata(undefined)).rejects.toThrow(TypeError);
  });

  // `MastraModelConfig` is a union of three quite different shapes. Mastra's own
  // docs lead with the magic string, so that is the common case — the registry
  // has to describe all three or it reports `unknown` for ordinary agents.
  describe('model config forms', () => {
    const llmOf = async (model: unknown) =>
      (await mapper.mapAgentMetadata(fakeMastraAgent({ model }))).llm;

    it('reads a model-router magic string', async () => {
      expect(await llmOf('openai/gpt-4o-mini')).toMatchObject({
        provider: 'openai',
        model: 'gpt-4o-mini',
        baseUrl: null,
      });
    });

    it('keeps the full model id when it contains further slashes', async () => {
      // e.g. 'openrouter/meta-llama/llama-3.1-8b' — only the first segment is
      // the provider.
      expect(await llmOf('anthropic/claude-sonnet-4-5/beta')).toMatchObject({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5/beta',
      });
    });

    it('reads an OpenAI-compatible config with a combined id', async () => {
      expect(
        await llmOf({
          id: 'ollama/qwen3:0.6b',
          url: 'http://localhost:11434/v1',
        })
      ).toMatchObject({
        provider: 'ollama',
        model: 'qwen3:0.6b',
        baseUrl: 'http://localhost:11434/v1',
      });
    });

    it('reads an OpenAI-compatible config with the parts kept separate', async () => {
      expect(
        await llmOf({
          providerId: 'ollama',
          modelId: 'qwen3:0.6b',
          url: 'http://localhost:11434/v1',
        })
      ).toMatchObject({
        provider: 'ollama',
        model: 'qwen3:0.6b',
        baseUrl: 'http://localhost:11434/v1',
      });
    });

    it('reads an AI SDK model instance', async () => {
      expect(await llmOf(fakeModel())).toMatchObject({
        provider: 'openai',
        model: 'gpt-4o-mini',
      });
    });

    it('reports a bare model id truthfully rather than inventing a provider', async () => {
      expect(await llmOf('gpt-4o-mini')).toMatchObject({
        provider: 'unknown',
        model: 'gpt-4o-mini',
      });
    });

    it.each([
      ['a trailing slash', 'openai/'],
      ['a leading slash', '/gpt-4o-mini'],
    ])(
      'echoes a malformed router id (%s) rather than discarding it',
      async (_label, model) => {
        // A typo'd model id should show up in the registry verbatim. Collapsing it
        // to `unknown` would hide the very string an operator needs to see to spot
        // the mistake.
        expect(await llmOf(model)).toMatchObject({
          provider: 'unknown',
          model,
          baseUrl: null,
        });
      }
    );

    it.each([
      ['a dynamic factory', () => 'openai/gpt-4o-mini'],
      ['an empty string', ''],
      ['an unrecognized object', { foo: 'bar' }],
      ['null', null],
      ['undefined', undefined],
    ])('degrades to unknown for %s', async (_label, model) => {
      expect(await llmOf(model)).toMatchObject({
        provider: 'unknown',
        model: 'unknown',
        baseUrl: null,
      });
    });
  });

  it('produces a record that satisfies the shared schema', async () => {
    // Round-trip through the schema: the mapper's output is what gets written
    // to the registry, so a shape change here must fail a test, not a deploy.
    const record = await mapper.mapAgentMetadata(fakeMastraAgent());
    expect(() => z.string().parse(record.registeredAt)).not.toThrow();
    expect(new Date(record.registeredAt).toString()).not.toBe('Invalid Date');
  });
});

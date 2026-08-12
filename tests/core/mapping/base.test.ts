// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';

import {
  BaseAgentMapper,
  SupportedFrameworks,
  UNKNOWN_PROVIDER,
  type AgentMetadataRecord,
  type SupportedFramework,
} from '@diagrid/agent-core';

/**
 * Minimal concrete mapper, used to exercise the parts of the base class that
 * every framework mapper inherits: provider extraction and record
 * finalization.
 */
class ProbeMapper extends BaseAgentMapper {
  override readonly framework: SupportedFramework = SupportedFrameworks.MASTRA;

  override mapAgentMetadata(agent: unknown): AgentMetadataRecord {
    const name = typeof agent === 'string' ? agent : 'probe';
    return this.finalize({
      name,
      registeredAt: '2026-08-11T00:00:00.000Z',
      agent: {
        appid: '',
        type: 'Probe',
        orchestrator: false,
        role: 'Assistant',
        goal: '',
        instructions: [],
        systemPrompt: '',
        framework: this.framework,
        maxIterations: 1,
        toolChoice: 'auto',
        metadata: null,
      },
      llm: {
        client: '',
        provider: UNKNOWN_PROVIDER,
        api: 'chat',
        model: 'unknown',
      },
      pubsub: { resourceName: '' },
      memory: {},
      registry: {},
      tools: [],
    });
  }

  /** Expose the protected static for testing. */
  static provider(moduleName: string | undefined): string {
    return ProbeMapper.extractProvider(moduleName);
  }
}

describe('BaseAgentMapper.extractProvider', () => {
  it.each([
    ['@ai-sdk/openai', 'openai'],
    ['@ai-sdk/anthropic', 'anthropic'],
    ['@ai-sdk/google', 'google'],
    ['@ai-sdk/mistral', 'mistral'],
    ['@ai-sdk/cohere', 'cohere'],
    ['@ai-sdk/amazon-bedrock', 'bedrock'],
    ['ollama-ai-provider', 'ollama'],
    ['gemini-1.5-pro', 'google'],
  ])('maps %j to %j', (input, expected) => {
    expect(ProbeMapper.provider(input)).toBe(expected);
  });

  it('prefers the more specific provider when substrings overlap', () => {
    // '@ai-sdk/azure' also contains no 'openai', but Azure model ids often do
    // — either way the answer must be azure_openai, never plain openai.
    expect(ProbeMapper.provider('@ai-sdk/azure')).toBe('azure_openai');
    expect(ProbeMapper.provider('azure-openai-deployment')).toBe(
      'azure_openai'
    );
    expect(ProbeMapper.provider('@ai-sdk/google-vertex')).toBe('vertexai');
  });

  it('is case-insensitive', () => {
    expect(ProbeMapper.provider('@AI-SDK/OpenAI')).toBe('openai');
  });

  it.each([[undefined], [''], ['some-unrelated-package']])(
    'falls back to unknown for %j',
    (input) => {
      expect(ProbeMapper.provider(input)).toBe(UNKNOWN_PROVIDER);
    }
  );
});

describe('BaseAgentMapper.finalize', () => {
  const mapper = new ProbeMapper();

  it('derives the workflow name from the framework and agent name', () => {
    expect(mapper.mapAgentMetadata('catering-coordinator').workflowName).toBe(
      'dapr.mastra.CateringCoordinator.workflow'
    );
  });

  it('stamps the current schema version', () => {
    expect(mapper.mapAgentMetadata('probe').version).toBe('0.1.0');
  });

  it('validates the record, so a malformed mapper fails loudly', () => {
    class BrokenMapper extends ProbeMapper {
      override mapAgentMetadata(): AgentMetadataRecord {
        // `name` is required by the schema; omitting it is the class of bug
        // this parse exists to catch before anything reaches the registry.
        return this.finalize({} as never);
      }
    }

    expect(() => new BrokenMapper().mapAgentMetadata()).toThrow();
  });
});

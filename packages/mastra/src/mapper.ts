// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Mastra implementation of the shared {@link BaseAgentMapper} contract.
 *
 * This is the piece a new framework has to provide: it reads a
 * framework-native agent object and produces the language-agnostic registry
 * record that Catalyst renders.
 *
 * Introspection is duck-typed on purpose. `@mastra/core` is a *peer*
 * dependency, so this module must not import it at runtime — doing so would
 * drag Mastra into the dependency graph of anyone who installs a different
 * adapter, which is exactly what
 * `tests/guards/cross-framework-imports.test.ts` forbids. The shapes below
 * are the public surface of a Mastra `Agent`; the guard tests pin them.
 */

import {
  BaseAgentMapper,
  SupportedFrameworks,
  type AgentMetadataRecord,
  type MapAgentMetadataOptions,
  type SupportedFramework,
  type ToolMetadata,
} from '@diagrid/agent-core';
import { z } from 'zod';

/**
 * The subset of a Mastra `Agent` this mapper reads.
 *
 * Every field is optional because Mastra accepts most of them as either a
 * value or a (possibly async) factory, and a factory cannot be resolved
 * without a runtime context. Unresolvable fields degrade to the schema
 * defaults rather than failing registration.
 */
export interface MastraAgentLike {
  readonly id?: string;
  readonly name?: string;
  readonly instructions?: unknown;
  readonly model?: unknown;
  readonly tools?: unknown;
  getInstructions?: (...args: never[]) => unknown;
  getModel?: (...args: never[]) => unknown;
  getTools?: (...args: never[]) => unknown;
}

/** Shape of the AI SDK model object Mastra is configured with. */
interface ModelLike {
  readonly modelId?: string;
  readonly provider?: string;
  readonly specificationVersion?: string;
  readonly baseURL?: string;
}

interface ToolLike {
  readonly id?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Read a Mastra config field that may be a plain value or a factory.
 *
 * Only synchronously-resolvable values are used. A dynamic (async) factory
 * needs a `RuntimeContext` that does not exist at registration time, so it is
 * skipped — the registry shows the static configuration, which is the useful
 * thing for an operator anyway.
 */
function readStatic(value: unknown): unknown {
  return typeof value === 'function' ? undefined : value;
}

/**
 * Render a tool's input schema as JSON Schema for the registry.
 *
 * Mastra tools carry a Zod `inputSchema`. Zod 4 can emit JSON Schema itself,
 * so no extra dependency is needed; Zod 3 (also inside our peer range) cannot,
 * and a schema containing transforms or custom refinements is not
 * representable at all. Every one of those cases degrades to an empty string —
 * the registry shows the tool without its argument shape rather than showing
 * `[object Object]`.
 */
function describeInputSchema(schema: unknown): string {
  if (!isRecord(schema)) {
    return '';
  }
  // `_zod` is the v4 internals marker; its absence means v3 or a non-Zod schema.
  if (!('_zod' in schema) || typeof z.toJSONSchema !== 'function') {
    return '';
  }
  try {
    // Cast through `unknown`: the `_zod` check above is the real guard, and
    // `toJSONSchema` is overloaded (schema | registry) so a structural cast
    // would bind to the wrong overload.
    return JSON.stringify(z.toJSONSchema(schema as unknown as z.ZodType));
  } catch {
    return '';
  }
}

function coerceInstructions(value: unknown): string[] {
  const resolved = readStatic(value);
  if (typeof resolved === 'string') {
    return resolved ? [resolved] : [];
  }
  if (Array.isArray(resolved)) {
    return resolved.filter(
      (entry): entry is string => typeof entry === 'string'
    );
  }
  // Mastra also accepts a `SystemMessage` object or an array of them.
  if (isRecord(resolved) && typeof resolved['content'] === 'string') {
    return [resolved['content']];
  }
  return [];
}

export class MastraAgentMapper extends BaseAgentMapper {
  override readonly framework: SupportedFramework = SupportedFrameworks.MASTRA;

  override mapAgentMetadata(
    agent: unknown,
    options: MapAgentMetadataOptions = {}
  ): AgentMetadataRecord {
    if (!isRecord(agent)) {
      throw new TypeError(
        `MastraAgentMapper expected a Mastra Agent object, received ${typeof agent}`
      );
    }

    const mastraAgent = agent as MastraAgentLike;
    const instructions = coerceInstructions(mastraAgent.instructions);
    const systemPrompt = instructions[0] ?? '';
    const name =
      options.name ?? mastraAgent.name ?? mastraAgent.id ?? 'mastra-agent';

    const model = readStatic(mastraAgent.model);
    const modelLike: ModelLike = isRecord(model) ? model : {};

    const record: Parameters<MastraAgentMapper['finalize']>[0] = {
      name,
      registeredAt: new Date().toISOString(),
      agent: {
        appid: '',
        type: agent.constructor?.name ?? 'Agent',
        orchestrator: false,
        role: 'Assistant',
        goal: systemPrompt,
        instructions,
        systemPrompt,
        framework: this.framework,
        // TODO(mastra-adapter): read the real cap once the runner threads its
        // `maxIterations` (and Mastra's `maxSteps`) through to the mapper.
        maxIterations: 1,
        toolChoice: 'auto',
        metadata: null,
      },
      llm: {
        client: modelLike.provider ?? '',
        provider: MastraAgentMapper.extractProvider(
          modelLike.provider ?? modelLike.modelId
        ),
        api: 'chat',
        model: modelLike.modelId ?? 'unknown',
        baseUrl: modelLike.baseURL ?? null,
        resourceName: null,
        azureEndpoint: null,
        azureDeployment: null,
        promptTemplate: null,
      },
      // TODO(mastra-adapter): populate from the runner's discovered Dapr
      // components once component discovery lands (python-ai does this in
      // `diagrid/agent/core/discovery.py`).
      pubsub: { resourceName: '', broadcastTopic: null, agentTopic: null },
      memory: {
        shortTerm: { type: 'DaprMastraCheckpointer', resourceName: null },
        longTerm: null,
      },
      registry: { resourceName: null, name: null },
      tools: MastraAgentMapper.extractTools(mastraAgent),
    };

    if (options.schemaVersion !== undefined) {
      record.version = options.schemaVersion;
    }

    return this.finalize(record);
  }

  /**
   * Read Mastra's tool map into registry tool metadata.
   *
   * Mastra keys `tools` by tool name and each entry carries `id`,
   * `description` and an `inputSchema`.
   */
  private static extractTools(agent: MastraAgentLike): ToolMetadata[] {
    const tools = readStatic(agent.tools);
    if (!isRecord(tools)) {
      return [];
    }

    return Object.entries(tools).flatMap(([toolName, rawTool]) => {
      if (!isRecord(rawTool)) {
        return [];
      }
      const tool: ToolLike = rawTool;
      return [
        {
          name: tool.id ?? toolName,
          description: tool.description ?? '',
          args: describeInputSchema(tool.inputSchema),
        },
      ];
    });
  }
}

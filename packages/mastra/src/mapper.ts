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
  UNKNOWN_PROVIDER,
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

/**
 * A Mastra model config, normalized to the fields the registry publishes.
 *
 * Mastra accepts the model in three different shapes (see {@link resolveModel}),
 * so nothing downstream should branch on which one was used.
 */
interface ResolvedModel {
  /** Client/provider identifier as configured, for display. */
  readonly client: string;
  /** Normalized provider id (`openai`, `azure_openai`, `ollama`, …). */
  readonly provider: string;
  /** Bare model id, with any `provider/` prefix removed. */
  readonly modelId: string;
  /** Custom endpoint, when the config points somewhere other than the default. */
  readonly baseUrl: string | null;
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
 * Read a Mastra agent config value, preferring the class accessor.
 *
 * A real `Agent` instance keeps most of its configuration private and exposes
 * it through methods — `getInstructions()`, `listTools()` — so reading the
 * plain property returns `undefined`. A plain object shaped like an agent (what
 * tests and the metadata-only path use) has the property and no accessor. Try
 * the accessor first, fall back to the property, and let the caller deal with a
 * Promise if the accessor returned one.
 *
 * This is the gap that shipping an example caught: the property-only version of
 * this lookup passed every unit test written against object fixtures while
 * reporting empty instructions and zero tools for every real agent.
 */
function readConfig(
  agent: MastraAgentLike,
  property: 'instructions' | 'model' | 'tools',
  accessor: 'getInstructions' | 'getModel' | 'getTools' | 'listTools'
): unknown {
  const method = (agent as Record<string, unknown>)[accessor];
  if (typeof method === 'function') {
    try {
      return (method as (this: MastraAgentLike) => unknown).call(agent);
    } catch {
      // Some accessors require a RuntimeContext we do not have. Fall through to
      // the raw property rather than failing registration over metadata.
    }
  }
  return readStatic(agent[property]);
}

const UNRESOLVED_MODEL: ResolvedModel = {
  client: '',
  provider: UNKNOWN_PROVIDER,
  modelId: 'unknown',
  baseUrl: null,
};

/** Split Mastra's `provider/model` router id. Returns undefined if not that shape. */
function splitRouterId(
  id: string
): { providerId: string; modelId: string } | undefined {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) {
    return undefined;
  }
  return { providerId: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

/**
 * Normalize any of Mastra's model-config shapes.
 *
 * `MastraModelConfig` is a union of three quite different things, and the
 * registry has to describe all of them:
 *
 * 1. **A model-router magic string** — `'openai/gpt-4o-mini'`. This is the form
 *    Mastra's own docs lead with, so it is the common case, not an edge case.
 * 2. **An OpenAI-compatible config object** — either `{ id: 'provider/model',
 *    url? }` or `{ providerId, modelId, url? }`. This is how you point an agent
 *    at Ollama or any other OpenAI-shaped endpoint.
 * 3. **An AI SDK model instance** — `openai('gpt-4o-mini')`, carrying
 *    `modelId` / `provider` / `baseURL`.
 *
 * Anything else (including a dynamic factory, which cannot be resolved without
 * a `RuntimeContext`) degrades to {@link UNRESOLVED_MODEL} rather than guessing.
 */
function resolveModel(
  raw: unknown,
  normalizeProvider: (moduleName: string | undefined) => string
): ResolvedModel {
  const model = readStatic(raw);

  // Form 1: model-router magic string.
  if (typeof model === 'string') {
    const split = splitRouterId(model);
    if (!split) {
      // A bare model id with no provider segment. Report the id truthfully and
      // leave the provider unknown rather than inventing one.
      return model
        ? { ...UNRESOLVED_MODEL, client: model, modelId: model }
        : UNRESOLVED_MODEL;
    }
    return {
      client: split.providerId,
      provider: normalizeProvider(split.providerId),
      modelId: split.modelId,
      baseUrl: null,
    };
  }

  if (!isRecord(model)) {
    return UNRESOLVED_MODEL;
  }

  const url = typeof model['url'] === 'string' ? model['url'] : undefined;

  // Form 2a: OpenAI-compatible config with a combined `provider/model` id.
  if (typeof model['id'] === 'string') {
    const split = splitRouterId(model['id']);
    const providerId = split?.providerId ?? '';
    return {
      client: providerId || model['id'],
      provider: normalizeProvider(providerId || model['id']),
      modelId: split?.modelId ?? model['id'],
      baseUrl: url ?? null,
    };
  }

  // Form 2b: OpenAI-compatible config with the parts kept separate.
  if (
    typeof model['providerId'] === 'string' &&
    typeof model['modelId'] === 'string'
  ) {
    return {
      client: model['providerId'],
      provider: normalizeProvider(model['providerId']),
      modelId: model['modelId'],
      baseUrl: url ?? null,
    };
  }

  // Form 3: an AI SDK language-model instance.
  if (typeof model['modelId'] === 'string') {
    const provider =
      typeof model['provider'] === 'string' ? model['provider'] : undefined;
    const baseURL =
      typeof model['baseURL'] === 'string' ? model['baseURL'] : undefined;
    return {
      client: provider ?? '',
      provider: normalizeProvider(provider ?? model['modelId']),
      modelId: model['modelId'],
      baseUrl: baseURL ?? url ?? null,
    };
  }

  return UNRESOLVED_MODEL;
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

  override async mapAgentMetadata(
    agent: unknown,
    options: MapAgentMetadataOptions = {}
  ): Promise<AgentMetadataRecord> {
    if (!isRecord(agent)) {
      throw new TypeError(
        `MastraAgentMapper expected a Mastra Agent object, received ${typeof agent}`
      );
    }

    const mastraAgent = agent as MastraAgentLike;
    const instructions = coerceInstructions(
      readConfig(mastraAgent, 'instructions', 'getInstructions')
    );
    const systemPrompt = instructions[0] ?? '';
    const name =
      options.name ?? mastraAgent.name ?? mastraAgent.id ?? 'mastra-agent';

    // Wrapped rather than passed by reference: `extractProvider` is a static,
    // and handing the bare method reference around detaches it from the class.
    const model = resolveModel(mastraAgent.model, (moduleName) =>
      MastraAgentMapper.extractProvider(moduleName)
    );

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
        client: model.client,
        provider: model.provider,
        api: 'chat',
        model: model.modelId,
        baseUrl: model.baseUrl,
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
      tools: await MastraAgentMapper.extractTools(mastraAgent),
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
   * `description` and an `inputSchema`. A real `Agent` only exposes this via
   * `listTools()`, which returns a Promise — the reason
   * {@link AgentMapper.mapAgentMetadata} is async.
   */
  private static async extractTools(
    agent: MastraAgentLike
  ): Promise<ToolMetadata[]> {
    const tools = await readConfig(agent, 'tools', 'listTools');
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

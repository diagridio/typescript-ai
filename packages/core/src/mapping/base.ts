// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The framework extension point.
 *
 * Adding support for a new TypeScript agent framework means implementing one
 * subclass of {@link BaseAgentMapper} (plus the four adapter modules — runner,
 * workflow, models, state — that `packages/mastra` demonstrates). Everything
 * downstream of the mapper — registry publication, workflow naming,
 * telemetry — is framework-agnostic and lives in this package.
 *
 * Port of `diagrid/agent/core/metadata/mapping/base.py` in
 * `diagridio/python-ai`.
 */

import {
  agentMetadataRecordSchema,
  METADATA_SCHEMA_VERSION,
  type AgentMetadataRecord,
} from '../metadata/schema';
import type { SupportedFramework } from '../types/frameworks';
import { buildWorkflowName } from '../workflow/naming';

/** Options a runner passes to the mapper when publishing metadata. */
export interface MapAgentMetadataOptions {
  /**
   * Runner-provided name. When set it is used as the canonical metadata name
   * instead of deriving one from the agent's own properties, so the registry
   * entry and the workflow name cannot disagree.
   */
  readonly name?: string;
  /** Schema version to stamp on the record. */
  readonly schemaVersion?: string;
}

/** Contract every framework mapper satisfies. */
export interface AgentMapper {
  /** Framework this mapper understands. */
  readonly framework: SupportedFramework;
  /** Map a framework-native agent onto the shared registry schema. */
  mapAgentMetadata(
    agent: unknown,
    options?: MapAgentMetadataOptions
  ): AgentMetadataRecord;
}

/**
 * Known LLM provider identifiers, most specific first.
 *
 * Order matters: `@ai-sdk/azure` must match `azure_openai` before the plain
 * `openai` substring gets a chance. Mirrors `_extract_provider` in the Python
 * base mapper, including the returned identifiers.
 */
const PROVIDER_PATTERNS: ReadonlyArray<
  readonly [needle: string, provider: string]
> = [
  ['vertexai', 'vertexai'],
  ['vertex', 'vertexai'],
  ['bedrock', 'bedrock'],
  ['azure', 'azure_openai'],
  ['openai', 'openai'],
  ['anthropic', 'anthropic'],
  ['ollama', 'ollama'],
  ['google', 'google'],
  ['gemini', 'google'],
  ['cohere', 'cohere'],
  ['mistral', 'mistral'],
];

/** Provider identifier used when nothing matches. */
export const UNKNOWN_PROVIDER = 'unknown';

export abstract class BaseAgentMapper implements AgentMapper {
  abstract readonly framework: SupportedFramework;

  abstract mapAgentMetadata(
    agent: unknown,
    options?: MapAgentMetadataOptions
  ): AgentMetadataRecord;

  /**
   * Derive a provider identifier from a module specifier or model id.
   *
   * In the Node ecosystem the useful signal is the AI SDK provider package
   * (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `ollama-ai-provider`, …) or the
   * model string itself, so this accepts either.
   *
   * ```text
   * '@ai-sdk/openai'      -> 'openai'
   * '@ai-sdk/azure'       -> 'azure_openai'
   * 'ollama-ai-provider'  -> 'ollama'
   * 'something-else'      -> 'unknown'
   * ```
   */
  protected static extractProvider(moduleName: string | undefined): string {
    if (!moduleName) {
      return UNKNOWN_PROVIDER;
    }
    const haystack = moduleName.toLowerCase();
    for (const [needle, provider] of PROVIDER_PATTERNS) {
      if (haystack.includes(needle)) {
        return provider;
      }
    }
    return UNKNOWN_PROVIDER;
  }

  /**
   * Validate and finalize a metadata record.
   *
   * Subclasses assemble a partial record from framework introspection and
   * hand it here; this fills defaults, derives the canonical workflow name,
   * and validates the result. Introspection reads shapes we do not own, so
   * the parse is the boundary check — a mapper that produces a malformed
   * record fails here rather than writing junk into the registry.
   */
  protected finalize(
    record: Omit<AgentMetadataRecord, 'workflowName' | 'version'> & {
      version?: string;
      workflowName?: string;
    }
  ): AgentMetadataRecord {
    return agentMetadataRecordSchema.parse({
      ...record,
      version: record.version ?? METADATA_SCHEMA_VERSION,
      workflowName:
        record.workflowName ?? buildWorkflowName(this.framework, record.name),
    });
  }
}

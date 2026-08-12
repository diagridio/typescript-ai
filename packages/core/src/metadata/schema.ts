// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Agent registry metadata schemas.
 *
 * These mirror the `AgentMetadataSchema` family that dapr-agents publishes to
 * the agent registry (see `dapr_agents.AgentMetadataSchema` and its use in
 * `diagridio/python-ai`'s `diagrid/agent/core/metadata/`). Keeping the shape
 * identical is what lets a Catalyst project render a TypeScript agent and a
 * Python agent in the same registry view.
 *
 * Zod is the runtime boundary: metadata is assembled from framework
 * introspection (i.e. from `unknown` shapes we do not control), so it is
 * validated before it is written to the state store rather than trusted.
 */

import { z } from 'zod';

/** Current metadata schema version emitted by this SDK. */
export const METADATA_SCHEMA_VERSION = '0.1.0';

export const llmMetadataSchema = z.object({
  /** Client class name, e.g. `OpenAIProvider`. */
  client: z.string().default(''),
  /** Normalized provider id, e.g. `openai`, `anthropic`, `ollama`. */
  provider: z.string().default('unknown'),
  /** API surface used, e.g. `chat`. */
  api: z.string().default('chat'),
  model: z.string().default('unknown'),
  resourceName: z.string().nullish(),
  baseUrl: z.string().nullish(),
  azureEndpoint: z.string().nullish(),
  azureDeployment: z.string().nullish(),
  promptTemplate: z.string().nullish(),
});

export const toolMetadataSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  /** Serialized argument schema. Stringified to match the Python adapters. */
  args: z.string().default(''),
});

export const pubSubMetadataSchema = z.object({
  resourceName: z.string().default(''),
  broadcastTopic: z.string().nullish(),
  agentTopic: z.string().nullish(),
});

export const memoryStoreMetadataSchema = z.object({
  type: z.string(),
  resourceName: z.string().nullish(),
});

export const memoryMetadataSchema = z.object({
  shortTerm: memoryStoreMetadataSchema.nullish(),
  longTerm: memoryStoreMetadataSchema.nullish(),
});

export const registryMetadataSchema = z.object({
  resourceName: z.string().nullish(),
  name: z.string().nullish(),
});

export const agentMetadataSchema = z.object({
  /** Dapr app id the agent is served under. Empty until the runner starts. */
  appid: z.string().default(''),
  /** Concrete framework class name of the wrapped agent. */
  type: z.string().default(''),
  orchestrator: z.boolean().default(false),
  role: z.string().default('Assistant'),
  goal: z.string().default(''),
  instructions: z.array(z.string()).default([]),
  systemPrompt: z.string().default(''),
  framework: z.string(),
  maxIterations: z.number().int().positive().default(1),
  toolChoice: z.string().default('auto'),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

/**
 * Top-level record a runner publishes for one agent.
 *
 * `workflowName` is not part of the dapr-agents schema; it is added here
 * because the TypeScript adapters compute it up front via
 * {@link buildWorkflowName} and the registry is the natural place to surface
 * it to operators.
 */
export const agentMetadataRecordSchema = z.object({
  version: z.string().default(METADATA_SCHEMA_VERSION),
  name: z.string(),
  workflowName: z.string(),
  registeredAt: z.string(),
  agent: agentMetadataSchema,
  llm: llmMetadataSchema,
  pubsub: pubSubMetadataSchema,
  memory: memoryMetadataSchema,
  registry: registryMetadataSchema,
  tools: z.array(toolMetadataSchema).default([]),
});

export type LlmMetadata = z.infer<typeof llmMetadataSchema>;
export type ToolMetadata = z.infer<typeof toolMetadataSchema>;
export type PubSubMetadata = z.infer<typeof pubSubMetadataSchema>;
export type MemoryStoreMetadata = z.infer<typeof memoryStoreMetadataSchema>;
export type MemoryMetadata = z.infer<typeof memoryMetadataSchema>;
export type RegistryMetadata = z.infer<typeof registryMetadataSchema>;
export type AgentMetadata = z.infer<typeof agentMetadataSchema>;
export type AgentMetadataRecord = z.infer<typeof agentMetadataRecordSchema>;

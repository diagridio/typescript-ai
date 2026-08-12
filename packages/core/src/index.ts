// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * `@diagrid/agent-core` — shared Dapr Workflow runtime for the Diagrid AI
 * agent adapters.
 *
 * Framework adapters (`@diagrid/agent-mastra`, and whatever comes next) build
 * on the primitives exported here. Application code normally imports the
 * adapter, not this package directly; the exception is when you are writing a
 * new adapter, in which case {@link BaseWorkflowRunner} and
 * {@link BaseAgentMapper} are the two things to implement.
 */

export { VERSION } from './version';

export {
  ALL_SUPPORTED_FRAMEWORKS,
  isSupportedFramework,
  SupportedFrameworks,
  type SupportedFramework,
} from './types/frameworks';

export { buildWorkflowName, sanitizeAgentName } from './workflow/naming';

export type {
  DaprWorkflowClient,
  Task,
  TWorkflow,
  WorkflowActivityContext,
  WorkflowContext,
  WorkflowFailureDetails,
  WorkflowRuntime,
  WorkflowRuntimeStatus,
  WorkflowState,
} from './workflow/dapr';

export {
  BaseWorkflowRunner,
  type BaseWorkflowRunnerOptions,
  type RunnerStatus,
} from './workflow/runner';

export {
  BaseAgentMapper,
  UNKNOWN_PROVIDER,
  type AgentMapper,
  type MapAgentMetadataOptions,
} from './mapping/base';

export {
  agentMetadataRecordSchema,
  agentMetadataSchema,
  llmMetadataSchema,
  memoryMetadataSchema,
  memoryStoreMetadataSchema,
  METADATA_SCHEMA_VERSION,
  pubSubMetadataSchema,
  registryMetadataSchema,
  toolMetadataSchema,
  type AgentMetadata,
  type AgentMetadataRecord,
  type LlmMetadata,
  type MemoryMetadata,
  type MemoryStoreMetadata,
  type PubSubMetadata,
  type RegistryMetadata,
  type ToolMetadata,
} from './metadata/schema';

export {
  DaprStateStore,
  DEFAULT_STORE_NAME,
  type DaprStateStoreOptions,
  type StateClient,
} from './state/store';

export {
  DaprPubSub,
  DEFAULT_PUBSUB_NAME,
  type DaprPubSubOptions,
  type PubSubClient,
} from './pubsub/pubsub';

export {
  getTracer,
  OTEL_ENDPOINT_ENV,
  OTEL_SERVICE_NAME_ENV,
  resolveOtlpEndpoint,
  resolveOtlpHeaders,
  resolveServiceName,
  setupTelemetry,
  type ObservabilityConfig,
  type TelemetryHandle,
} from './telemetry/telemetry';

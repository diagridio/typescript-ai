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
  WorkflowState,
} from './workflow/dapr';

// Declared locally, not re-exported from @dapr/dapr — see ./workflow/status.ts.
export { WorkflowRuntimeStatus, workflowStatusName } from './workflow/status';

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

// --- The durable agent loop ------------------------------------------------
// Framework-agnostic: an adapter supplies the model/tool invokers and the
// framework token, and gets the orchestrator, its activities and its I/O
// schemas from here. Previously these lived in the Mastra adapter, where a
// second adapter would have had to copy them.
export {
  ACTIVITY_INVOKE_MODEL,
  ACTIVITY_INVOKE_TOOL,
  ACTIVITY_MAX_ATTEMPTS,
  ACTIVITY_RETRY_BASE_DELAY_MS,
  MAX_TOOL_RESULT_CHARS,
  activityNamesFor,
  agentWorkflow,
  invokeModelActivity,
  invokeToolActivity,
} from './agent/workflow';

export type { ModelInvoker, ToolInvoker, ToolInvokers } from './agent/workflow';

export {
  WorkflowStatus,
  agentWorkflowInputSchema,
  agentWorkflowOutputSchema,
  scheduledWorkflowInputSchema,
  checkpointIndexSchema,
  checkpointSchema,
  invokeModelInputSchema,
  invokeModelOutputSchema,
  invokeToolInputSchema,
  invokeToolOutputSchema,
  messageRoleSchema,
  messageSchema,
  workflowStatusSchema,
} from './agent/models';

export type {
  AgentWorkflowInput,
  AgentWorkflowOutput,
  ScheduledWorkflowInput,
  Checkpoint,
  CheckpointIndex,
  InvokeModelInput,
  InvokeModelOutput,
  InvokeToolInput,
  InvokeToolOutput,
  Message,
  MessageRole,
  WorkflowStatusValue,
} from './agent/models';

export {
  DaprAgentCheckpointer,
  checkpointKey,
  threadIndexKey,
} from './state/checkpointer';

export type {
  DaprAgentCheckpointerOptions,
  SaveCheckpointArgs,
} from './state/checkpointer';

// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * `@diagrid/agent-mastra` — durable execution of [Mastra](https://mastra.ai)
 * agents on Dapr Workflows.
 *
 * The agent's control loop is modelled as a Dapr Workflow and each model call
 * and tool execution as a durable activity, so an agent survives process
 * crashes, sidecar restarts and provider outages without re-running work it
 * already paid for.
 *
 * See the package README for the current implementation status — the adapter
 * is a compiling, testable scaffold, not yet a working integration.
 */

export { VERSION } from './version';

export {
  DaprWorkflowAgentRunner,
  type DaprWorkflowAgentRunnerOptions,
} from './runner';

export { MastraAgentMapper, type MastraAgentLike } from './mapper';

export {
  DaprMastraCheckpointer,
  type DaprMastraCheckpointerOptions,
  type SaveCheckpointArgs,
} from './state';

export {
  ACTIVITY_INVOKE_MODEL,
  ACTIVITY_INVOKE_TOOL,
  agentWorkflow,
  clearRegistries,
  invokeModelActivity,
  invokeToolActivity,
  registeredToolNames,
  registerModelInvoker,
  registerToolInvoker,
  type ModelInvoker,
  type ToolInvoker,
} from './workflow';

export {
  agentWorkflowInputSchema,
  agentWorkflowOutputSchema,
  checkpointIndexSchema,
  checkpointSchema,
  invokeModelInputSchema,
  invokeModelOutputSchema,
  invokeToolInputSchema,
  invokeToolOutputSchema,
  messageRoleSchema,
  messageSchema,
  WorkflowStatus,
  workflowStatusSchema,
  type AgentWorkflowInput,
  type AgentWorkflowOutput,
  type Checkpoint,
  type CheckpointIndex,
  type InvokeModelInput,
  type InvokeModelOutput,
  type InvokeToolInput,
  type InvokeToolOutput,
  type Message,
  type MessageRole,
  type WorkflowStatusValue,
} from './models';

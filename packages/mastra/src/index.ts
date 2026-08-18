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
 * Verified end to end against a live Dapr sidecar: a real agent turn completes
 * with tool calls executed as separate activities, and a process killed mid-turn
 * resumes without recomputing completed work. See the package README.
 */

export { VERSION } from './version';

export {
  DaprWorkflowAgentRunner,
  WorkflowTimeoutError,
  type DaprWorkflowAgentRunnerOptions,
} from './runner';

export {
  createModelInvoker,
  createToolInvokers,
  definitionOnlyTools,
  readTools,
  toModelMessages,
} from './bridge';

export { MastraAgentMapper, type MastraAgentLike } from './mapper';

export {
  DaprMastraCheckpointer,
  MASTRA_KEY_PREFIX,
  type DaprMastraCheckpointerOptions,
} from './state';

// Re-exported from `@diagrid/agent-core`, where the durable agent loop and its
// I/O schemas now live — they never mentioned Mastra, and a second adapter would
// have had to copy them. Kept on this package's surface so importing the adapter
// remains enough to work with a turn.
export {
  ACTIVITY_INVOKE_MODEL,
  ACTIVITY_INVOKE_TOOL,
  ACTIVITY_MAX_ATTEMPTS,
  ACTIVITY_RETRY_BASE_DELAY_MS,
  MAX_TOOL_RESULT_CHARS,
  activityNamesFor,
  agentWorkflow,
  agentWorkflowInputSchema,
  agentWorkflowOutputSchema,
  checkpointIndexSchema,
  checkpointSchema,
  invokeModelActivity,
  invokeModelInputSchema,
  invokeModelOutputSchema,
  invokeToolActivity,
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
  type ModelInvoker,
  type SaveCheckpointArgs,
  type ScheduledWorkflowInput,
  type ToolInvoker,
  type ToolInvokers,
  type WorkflowStatusValue,
} from '@diagrid/agent-core';

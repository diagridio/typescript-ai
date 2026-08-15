// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * I/O models for the Mastra ↔ Dapr Workflow integration.
 *
 * Everything that crosses the workflow boundary is defined here as a Zod
 * schema rather than a bare interface. Two reasons:
 *
 * 1. Dapr persists workflow input, activity input and activity output as JSON
 *    in the state store. On replay those values come back from storage — i.e.
 *    from outside the process — so they are validated, not trusted. A schema
 *    change that would silently mis-read an in-flight workflow surfaces as a
 *    parse error instead of corrupt agent state.
 * 2. Mastra already speaks Zod for tool and output schemas, so the adapter and
 *    the framework share one validation vocabulary.
 */

import { z } from 'zod';

/** Status of an agent workflow execution. */
export const WorkflowStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TERMINATED: 'terminated',
} as const;

export type WorkflowStatusValue =
  (typeof WorkflowStatus)[keyof typeof WorkflowStatus];

export const workflowStatusSchema = z.enum([
  WorkflowStatus.PENDING,
  WorkflowStatus.RUNNING,
  WorkflowStatus.COMPLETED,
  WorkflowStatus.FAILED,
  WorkflowStatus.TERMINATED,
]);

/** Role of a message in the conversation transcript. */
export const messageRoleSchema = z.enum([
  'system',
  'user',
  'assistant',
  'tool',
]);

/** A single message in the durable transcript. */
export const messageSchema = z.object({
  role: messageRoleSchema,
  content: z.string(),
  /** Present on `tool` messages: the call this message answers. */
  toolCallId: z.string().optional(),
  /** Present on `assistant` messages that requested tool calls. */
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        /** JSON-encoded arguments, kept as a string so replay is byte-stable. */
        args: z.string(),
      })
    )
    .optional(),
});

/** Input to the `invokeModel` activity — one LLM call. */
export const invokeModelInputSchema = z.object({
  /** Conversation so far, oldest first. */
  messages: z.array(messageSchema),
  /** Iteration index within the agent loop, for tracing and step caps. */
  iteration: z.number().int().nonnegative(),
  threadId: z.string(),
});

/** Output of the `invokeModel` activity. */
export const invokeModelOutputSchema = z.object({
  message: messageSchema,
  /** `true` when the model requested at least one tool call. */
  requiresToolCalls: z.boolean().default(false),
  usage: z
    .object({
      promptTokens: z.number().int().nonnegative().optional(),
      completionTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  error: z.string().optional(),
});

/** Input to the `invokeTool` activity — one tool execution. */
export const invokeToolInputSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  /** JSON-encoded arguments as produced by the model. */
  args: z.string(),
  threadId: z.string(),
});

/** Output of the `invokeTool` activity. */
export const invokeToolOutputSchema = z.object({
  toolCallId: z.string(),
  /** JSON-encoded tool result. */
  result: z.string(),
  error: z.string().optional(),
});

/** Input to the top-level agent workflow. */
export const agentWorkflowInputSchema = z.object({
  /** The user turn that starts this workflow. */
  prompt: z.string(),
  /**
   * Conversation thread this turn belongs to. Also the checkpoint key, so
   * resuming a crashed workflow and continuing a conversation are the same
   * operation.
   */
  threadId: z.string(),
  /** Prior transcript to seed the loop with, when resuming a thread. */
  messages: z.array(messageSchema).default([]),
  /** Hard cap on agent loop iterations. Mirrors the runner's maxIterations. */
  maxIterations: z.number().int().positive().default(25),
  /** Opaque per-run metadata forwarded to Mastra's runtime context. */
  runtimeContext: z.record(z.string(), z.unknown()).optional(),
  /**
   * Activity names this turn must call, scoped to the runner that scheduled it.
   *
   * Workflow names are already per-agent (`dapr.<framework>.<Agent>.workflow`),
   * but activity names were shared literals. Two runners in one process register
   * their own closures under those same names on separate worker streams against
   * the same sidecar, and the work-item request carries no capability list — so
   * the sidecar could hand runner A's tool call to runner B's connection, where a
   * handler exists and would answer it with B's tools. The orchestrator therefore
   * calls names carried in its own input rather than module constants.
   *
   * Optional so a workflow scheduled by an older version still runs: absent, it
   * falls back to the unscoped names.
   */
  activityNames: z.object({ model: z.string(), tool: z.string() }).optional(),
});

/** Output of the top-level agent workflow. */
/**
 * Output of the top-level agent workflow.
 *
 * Deliberately **without defaults**, unlike the input schema. An earlier version
 * defaulted every field, which meant an empty workflow output (`{}` or `null`)
 * parsed cleanly into `{ text: '', iterations: 0, status: 'completed' }` — a
 * successful-looking empty turn. That masked a workflow that completed without
 * running a single activity. Requiring the fields makes that failure loud, which
 * is the whole point of validating at this boundary.
 */
export const agentWorkflowOutputSchema = z.object({
  /** Final assistant text. Empty is legal, absent is not. */
  text: z.string(),
  /** Full transcript including tool calls and results. */
  messages: z.array(messageSchema),
  iterations: z.number().int().nonnegative(),
  status: workflowStatusSchema,
  error: z.string().optional(),
});

/** A persisted checkpoint for one conversation thread. */
export const checkpointSchema = z.object({
  threadId: z.string(),
  checkpointId: z.string(),
  messages: z.array(messageSchema).default([]),
  iteration: z.number().int().nonnegative().default(0),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

/** Index of the checkpoints belonging to one thread. */
export const checkpointIndexSchema = z.object({
  checkpoints: z.array(z.string()).default([]),
  latest: z.string().nullable().default(null),
});

export type MessageRole = z.infer<typeof messageRoleSchema>;
export type Message = z.infer<typeof messageSchema>;
export type InvokeModelInput = z.infer<typeof invokeModelInputSchema>;
export type InvokeModelOutput = z.infer<typeof invokeModelOutputSchema>;
export type InvokeToolInput = z.infer<typeof invokeToolInputSchema>;
export type InvokeToolOutput = z.infer<typeof invokeToolOutputSchema>;
/**
 * `z.input`, not `z.infer`.
 *
 * `z.infer` is the schema's *output* type, where `.default()`s have already been
 * applied — so `messages` and `maxIterations` come out required and
 * `invoke({ prompt, threadId })` does not compile. This is the caller-facing
 * type, so it has to be the input side. The quickstart in the READMEs and in
 * runner.ts is exactly that two-field call.
 */
export type AgentWorkflowInput = z.input<typeof agentWorkflowInputSchema>;
export type AgentWorkflowOutput = z.infer<typeof agentWorkflowOutputSchema>;
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type CheckpointIndex = z.infer<typeof checkpointIndexSchema>;

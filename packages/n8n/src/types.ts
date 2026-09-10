// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import type { IConnections, INode, INodeExecutionData } from 'n8n-workflow';

/**
 * Static, frozen-at-schedule-time description of the graph the orchestrator
 * walks. Nothing in here may change between replays — this is exactly what gets
 * passed to `DaprWorkflowClient.scheduleNewWorkflow` and is what the orchestrator
 * receives as its `input` on every replay. Validated against
 * `schemas.ts`'s `orchestrationInputSchema` wherever it's read back from Dapr's
 * own history rather than constructed directly by this package (see
 * run-durably.ts).
 */
export interface OrchestrationInput {
  nodes: INode[];
  connections: IConnections;
  /**
   * True for a sub-workflow orchestration dispatched via
   * `ctx.callChildWorkflow(...)` (orchestrator.ts), unset/false for a
   * top-level execution (run-durably.ts never sets it). The ONLY thing this
   * gates is whether the orchestrator dispatches
   * `SYNC_EXECUTION_STATUS_ACTIVITY_NAME` on completion, and whether the
   * generic activity syncs incremental execution-list progress: both write to
   * n8n's own `execution_entity`/`execution_data` tables keyed by
   * `ctx.getWorkflowInstanceId()`, which for a child is Dapr's own
   * auto-generated `${parentInstanceId}:XXXX` id — not a real n8n execution
   * id, since (deliberately — see README's sub-workflow scope) no
   * execution-list entry is ever created for a sub-workflow.
   *
   * TODO(n8n-integration): a sub-workflow child genuinely has no
   * execution-list row of its own today — this flag exists to skip writes
   * that would otherwise fail confusingly, not to provide the row. Giving a
   * child its own visible execution-list entry is real, separate scope.
   */
  isSubWorkflow?: boolean | undefined;
  /**
   * Pre-computed output for whatever node(s) `WorkflowExecute.run()` already
   * placed on the initial `nodeExecutionStack` before `processRunExecutionData`
   * (and therefore our patch) ever runs — the trigger node for a normal manual
   * run, or potentially more than one node for a partial/resume execution.
   *
   * This data is NOT re-derived by the orchestrator: trigger node types
   * (`ManualTrigger` and friends) don't implement `execute()` at all — they use
   * a completely different `trigger()`/`emit()` callback protocol
   * (`WorkflowExecute.executeTriggerNode`) that this package does not
   * replicate. Real n8n's own `.run()` already resolves this deterministically
   * (a manual test run always seeds the trigger with a single `{ json: {} }`
   * item) before `processRunExecutionData` is called, so it's legitimate,
   * frozen "input" the orchestrator can just replay rather than needing to
   * execute — see run-durably.ts for where this is read off the real
   * `WorkflowExecute` instance.
   */
  seed: Array<{ nodeName: string; outputItems: INodeExecutionData[][] }>;
}

/** What the orchestrator sends to the generic activity for one node-run attempt. */
export interface RunNodeInput {
  instanceId: string;
  nodeName: string;
  runIndex: number;
  /** 1-based. Distinct attempts get distinct ledger entries — see ledger.ts. */
  attempt: number;
  node: INode;
  /** Resolved input items per input index, already joined from upstream outputs by the orchestrator's graph-walk. */
  inputItems: INodeExecutionData[][];
  /**
   * Forwarded from `OrchestrationInput.isSubWorkflow` by whichever
   * orchestrator dispatches this activity, so the activity can skip
   * incremental execution-list progress syncing for a sub-workflow child the
   * same way the orchestrator already skips the final status sync — see this
   * field's own doc comment on `OrchestrationInput`.
   */
  isSubWorkflow?: boolean | undefined;
}

export type RunNodeOutput =
  | {
      status: 'success';
      nodeName: string;
      runIndex: number;
      startedAt: number;
      finishedAt: number;
      outputItems: INodeExecutionData[][];
    }
  | {
      status: 'error';
      nodeName: string;
      runIndex: number;
      startedAt: number;
      finishedAt: number;
      message: string;
      stack?: string | undefined;
    }
  | {
      /**
       * The node's real execute() ran to completion and called
       * `context.putExecutionToWait(waitTill)` (base-execute-context.ts) — e.g.
       * the Wait node. This is NOT a failure and NOT a normal completion: the
       * node produced real output (pass-through input data, same as
       * `WorkflowExecute`'s own `nodeSuccessData` for a waiting node — see
       * workflow-execute.ts's `taskData.executionStatus = waitTill ? 'waiting'
       * : 'success'`), but the orchestrator must not let downstream nodes
       * become "ready" until the wait itself resolves (a durable timer, an
       * external event, or whichever comes first — see orchestrator.ts).
       * `waitTill` is epoch milliseconds, not a `Date` — plain numbers survive
       * the JSON round-trip through Dapr's activity/ledger payloads
       * unambiguously; a serialized `Date` would come back as an ISO string
       * that every consumer would have to remember to re-parse.
       */
      status: 'waiting';
      nodeName: string;
      runIndex: number;
      startedAt: number;
      finishedAt: number;
      outputItems: INodeExecutionData[][];
      waitTill: number;
    };

/**
 * What actually lands in the orchestrator's `completed` map: a node is only
 * ever inserted once it's truly done — a `waiting` result is a mid-flight
 * state the orchestrator resolves (via a timer/event race) into a `success`
 * entry before it's ever added (see orchestrator.ts). Narrower than
 * `RunNodeOutput` on purpose, so both `toRunData` (orchestrator.ts) and
 * `completedNodeOutputToTaskData` (task-data.ts) don't need a runtime guard
 * for a case that should be structurally impossible.
 */
export type CompletedNodeOutput = Extract<
  RunNodeOutput,
  { status: 'success' | 'error' }
>;

/**
 * What `runN8nNodeOrchestrator`/`runN8nNodeOrchestratorV2` themselves return —
 * both what a top-level caller reads off `DaprWorkflowClient`'s
 * `serializedOutput` (run-durably.ts) and, unchanged, what a *parent*
 * orchestration reads directly off `yield ctx.callChildWorkflow(...)` for a
 * sub-workflow node (see orchestrator.ts). The same shape serves both because
 * a child orchestration is just another invocation of the same function.
 */
export type OrchestratorResult =
  | {
      status: 'success';
      nodeCount: number;
      nodes: string[];
      outputItems: INodeExecutionData[][];
    }
  | { status: 'error'; failedNode: string; message: string };

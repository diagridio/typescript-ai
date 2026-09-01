// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Workflow runtime status, declared locally rather than re-exported.
 *
 * Adapters need to compare a workflow's status against these members to tell a
 * completed run from a failed one, so this has to be a *value*. Re-exporting the
 * enum from `@dapr/dapr` made that package a static import of `@diagrid/agent-core`
 * — measured at ~136 `@dapr/dapr` modules plus ~65 from `@grpc/grpc-js` loaded on
 * a bare `require()`, before any adapter code runs, and it defeated the lazy
 * `await import('@dapr/dapr')` elsewhere in this package.
 *
 * The values are the DurableTask `OrchestrationStatus` protobuf numbers, which
 * are wire format and therefore stable.
 * `tests/core/workflow/status.test.ts` asserts they still match the SDK's enum,
 * so drift fails a test rather than silently mis-reading a status at runtime.
 */
export const WorkflowRuntimeStatus = {
  RUNNING: 0,
  COMPLETED: 1,
  CONTINUED_AS_NEW: 2,
  FAILED: 3,
  TERMINATED: 5,
  PENDING: 6,
  SUSPENDED: 7,
} as const;

export type WorkflowRuntimeStatus =
  (typeof WorkflowRuntimeStatus)[keyof typeof WorkflowRuntimeStatus];

/** Human-readable name for a status value, for error messages. */
export function workflowStatusName(status: number): string {
  return (
    Object.entries(WorkflowRuntimeStatus).find(
      ([, value]) => value === status
    )?.[0] ?? String(status)
  );
}

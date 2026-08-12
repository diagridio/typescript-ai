// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The Dapr Workflow surface adapters are allowed to depend on.
 *
 * Adapters import these types from `@diagrid/agent-core` rather than from
 * `@dapr/dapr` directly. Two reasons, both load-bearing:
 *
 * 1. **One place owns the Dapr version.** An adapter that imported
 *    `@dapr/dapr` itself would need its own dependency (or peer) range, and
 *    two adapters could then disagree about which SDK version they were
 *    written against.
 * 2. **The isolation guard stays meaningful.** With this re-export, an
 *    adapter's runtime dependency list collapses to `@diagrid/agent-core` plus
 *    its own framework's peer — which is exactly the invariant
 *    `tests/guards/cross-framework-imports.test.ts` asserts.
 *
 * These are type-only re-exports: nothing here adds to the runtime bundle.
 */

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
} from '@dapr/dapr';

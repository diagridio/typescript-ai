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
 * These are type-only re-exports: erased at compile time, so nothing here pulls
 * `@dapr/dapr` into the runtime graph.
 *
 * The one value that used to live here — the `WorkflowRuntimeStatus` enum — has
 * moved to {@link ../status}, declared locally. Re-exporting it from
 * `@dapr/dapr` made that a *static* import of this package: a bare
 * `require('@diagrid/agent-mastra')` loaded ~136 `@dapr/dapr` modules and ~65
 * from `@grpc/grpc-js` before any adapter code ran, which also meant the
 * `await import('@dapr/dapr')` sites in `runner.ts`, `store.ts` and `pubsub.ts`
 * deferred nothing — the graph was already resident.
 */

export type {
  DaprWorkflowClient,
  Task,
  TWorkflow,
  WorkflowActivityContext,
  WorkflowContext,
  WorkflowFailureDetails,
  WorkflowRuntime,
  WorkflowState,
} from '@dapr/dapr';

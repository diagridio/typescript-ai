// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * `@diagrid/n8n` — durable execution of n8n workflow node runs on
 * [Dapr Workflows](https://docs.dapr.io/developing-applications/building-blocks/workflow/).
 *
 * Attaches to a stock n8n process at load time (`NODE_OPTIONS="--require
 * @diagrid/n8n/register" n8n start`). No upstream n8n changes, no fork. Each
 * n8n node run becomes a durable Dapr activity, guarded by an idempotency
 * ledger, so a multi-node workflow survives a process crash and resumes from
 * its last completed node with no duplicate side effects.
 *
 * Verified end to end against a live Dapr sidecar and a real n8n process: a
 * killed-and-restarted n8n resumes a multi-node workflow correctly, branching
 * and retry both work, Wait nodes durably pause across a crash, sub-workflows
 * dispatch as real Dapr child workflows with symmetric parent/child crash
 * recovery, and — the exit criterion this move itself was built to prove —
 * an in-flight instance survives a real orchestrator code change deployed
 * alongside it. See the package README for the full evidence.
 */

export { VERSION } from './version';

export { register } from './register';
export { runDurably } from './run-durably';
export { runN8nNodeOrchestrator } from './orchestrator';
export { runN8nNodeOrchestratorV2 } from './orchestrator-v2';
export { runN8nNodeActivity } from './activity';
export {
  getRuntime,
  shutdownRuntime,
  registerShutdownHandlers,
} from './runtime';
export { readLedger, writeLedger, closeLedgerStore } from './ledger';
export { getSubWorkflowId, resolveSubWorkflowActivity } from './sub-workflow';
export type {
  ResolveSubWorkflowInput,
  ResolveSubWorkflowOutput,
} from './sub-workflow';
export {
  runSyncExecutionStatusActivity,
  syncExecutionStatus,
} from './execution-status-sync';
export type { SyncExecutionStatusInput } from './execution-status-sync';
export { syncNodeProgress } from './execution-progress';
export { runLogRoundStartActivity } from './round-log';
export type { LogRoundStartInput } from './round-log';
export { completedNodeOutputToTaskData } from './task-data';

export * from './types';
export * from './constants';
export * from './schemas';

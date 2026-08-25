// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Versioned names, registered explicitly rather than left to default name
 * inference — the design doc's own versioning-discipline recommendation
 * (risk register: "register orchestrator and activity functions under
 * versioned names; drain old in-flight instances before retiring old code"),
 * built and verified for real (not just asserted) before this package moved
 * here — see README's "Versioning discipline" section.
 *
 * Namespaced `diagrid.n8n.*` rather than reusing this repo's
 * `dapr.<framework>.<AgentName>.workflow` convention
 * (`packages/core/src/workflow/naming.ts`'s `buildWorkflowName`): that
 * function is keyed by `SupportedFramework`, a closed union n8n is
 * deliberately not a member of (see README's "Why not `SupportedFrameworks`"
 * section), and its whole point — one workflow name per *agent* — doesn't
 * fit n8n's shape anyway. Every n8n execution goes through the SAME
 * registered orchestrator name, differentiated by Dapr instance id (= the
 * real n8n execution id), not by a per-workflow registered name.
 */
export const ORCHESTRATOR_NAME = 'diagrid.n8n.orchestrator-v1';
export const ACTIVITY_NAME = 'diagrid.n8n.run-node-v1';

/**
 * A second, real orchestrator version, registered ALONGSIDE the
 * still-registered, unmodified v1 (see runtime.ts) — not a replacement.
 * `run-durably.ts` schedules new top-level executions against this name;
 * `ORCHESTRATOR_NAME` (v1) stays registered purely so any instance already
 * bound to it (its `ExecutionStarted` history event already says
 * `orchestrator-v1` — confirmed against the real SDK to be exactly what gets
 * re-resolved on every replay, see README) keeps draining correctly. See
 * orchestrator-v2.ts's own top-of-file doc comment for what's actually
 * different and why.
 */
export const ORCHESTRATOR_NAME_V2 = 'diagrid.n8n.orchestrator-v2';

/**
 * Dispatched by the orchestrator itself as its very last step, right before
 * returning — see orchestrator.ts and execution-status-sync.ts. This is NOT
 * called from run-durably.ts: `runDurably()` only ever runs inside the
 * *original* process's call stack, which a SIGKILL destroys along with it,
 * and nothing re-invokes `processRunExecutionData` for that same execution
 * afterward (confirmed empirically — regular mode's crash recovery only
 * rewrites n8n's own execution record from its event log, it never re-runs
 * the workflow). An activity, by contrast, is guaranteed to run in *some*
 * live, connected n8n process — the same guarantee every node-execution
 * activity already relies on — which is what makes this reliable across a
 * crash-and-resume and a normal completion alike.
 */
export const SYNC_EXECUTION_STATUS_ACTIVITY_NAME =
  'diagrid.n8n.sync-execution-status-v1';

/**
 * Prefix for the Dapr external-event name a waiting node's orchestrator-side
 * race listens for — the full event name is `RESUME_EVENT_PREFIX +
 * nodeName`. Shared between orchestrator.ts (the `ctx.waitForExternalEvent`
 * side) and whatever eventually calls
 * `DaprWorkflowClient.raiseEvent(instanceId, eventName, payload)`.
 *
 * TODO(n8n-integration): n8n's own webhook HTTP endpoint
 * (`waiting-webhooks.ts`/`live-webhooks.ts` in `packages/cli`) does not call
 * `raiseEvent` yet — proven only via a direct test-harness call. Wiring the
 * real webhook route is separate, not-yet-started work.
 */
export const RESUME_EVENT_PREFIX = 'resume:';

/**
 * Confirmed against the real, locally-built n8n-nodes-base
 * (packages/nodes-base/nodes/ExecuteWorkflow/ExecuteWorkflow/
 * ExecuteWorkflow.node.ts's `description.name: 'executeWorkflow'`, combined
 * with the package name the same way every other node type string in this
 * codebase already is — not assumed from the pattern alone. A plain string
 * equality check against `node.type` catches every version: `ExecuteWorkflow`
 * is light-versioned (`version: [1, 1.1, 1.2, 1.3]` on one class, no
 * `VersionedNodeType` wrapper — see sub-workflow.ts), so `.type` never
 * changes across versions, only `.typeVersion` does.
 */
export const EXECUTE_WORKFLOW_NODE_TYPE = 'n8n-nodes-base.executeWorkflow';

/**
 * Fetches a sub-workflow's nodes/connections by id — see sub-workflow.ts.
 * Deliberately NOT the generic ACTIVITY_NAME/runN8nNodeActivity path: an
 * Execute Workflow node is never dispatched through that path at all (see
 * orchestrator.ts and sub-workflow.ts's own doc comments for why real n8n's
 * `executeWorkflow()` minting a brand-new execution id on every call makes
 * that unsafe for a redelivered/retried attempt).
 */
export const RESOLVE_SUB_WORKFLOW_ACTIVITY_NAME =
  'diagrid.n8n.resolve-sub-workflow-v1';

/**
 * orchestrator-v2-only activity — see round-log.ts. Versioned like every
 * other name here even though only v2 calls it today, for the same house
 * reason `ORCHESTRATOR_NAME`/`ACTIVITY_NAME` already are: registered
 * explicitly rather than left to default inference.
 */
export const LOG_ROUND_START_ACTIVITY_NAME = 'diagrid.n8n.log-round-start-v1';

// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import type { WorkflowContext } from '@diagrid/agent-core';
import {
  DirectedGraph,
  filterDisabledNodes,
  recreateNodeExecutionStack,
} from 'n8n-core';
import { mapConnectionsByDestination } from 'n8n-workflow';
import type {
  IConnections,
  INode,
  INodeExecutionData,
  IRunData,
} from 'n8n-workflow';

import {
  ACTIVITY_NAME,
  EXECUTE_WORKFLOW_NODE_TYPE,
  ORCHESTRATOR_NAME,
  RESOLVE_SUB_WORKFLOW_ACTIVITY_NAME,
  RESUME_EVENT_PREFIX,
  SYNC_EXECUTION_STATUS_ACTIVITY_NAME,
} from './constants';
import type { SyncExecutionStatusInput } from './execution-status-sync';
import {
  orchestratorResultSchema,
  resolveSubWorkflowOutputSchema,
  runNodeOutputSchema,
} from './schemas';
import { getSubWorkflowId } from './sub-workflow';
import type {
  ResolveSubWorkflowInput,
  ResolveSubWorkflowOutput,
} from './sub-workflow';
import { completedNodeOutputToTaskData } from './task-data';
import type {
  CompletedNodeOutput,
  OrchestrationInput,
  OrchestratorResult,
  RunNodeInput,
  RunNodeOutput,
} from './types';

const RETRY_MAX_ATTEMPTS = 3;

function backoffSeconds(attempt: number): number {
  return Math.min(30, 2 ** attempt); // 2s, 4s, 8s, capped — a durable timer, so a crash mid-wait doesn't forfeit the retry
}

function toRunData(completed: Map<string, CompletedNodeOutput>): IRunData {
  const runData: IRunData = {};
  for (const [nodeName, result] of completed) {
    runData[nodeName] = [completedNodeOutputToTaskData(result)];
  }
  return runData;
}

/**
 * Whether a node has any outgoing 'main' connection at all — used both to
 * find a (sub-)workflow's terminal node(s) for its returned `outputItems`
 * (see `terminalOutputItems` below) and, in principle, reusable for similar
 * graph-shape questions. Works directly off the frozen, source-indexed
 * `IConnections` rather than a `DirectedGraph` instance — this is pure,
 * static-shape analysis over already-known input, so it doesn't need the
 * graph abstraction's traversal helpers.
 */
function hasOutgoingMainConnection(
  nodeName: string,
  connections: IConnections
): boolean {
  const outputs = connections[nodeName]?.['main'];
  return outputs?.some((conns) => conns && conns.length > 0) ?? false;
}

/**
 * A (sub-)workflow's output, for whichever caller needs the actual item data
 * out of a completed orchestration — the parent orchestrator, reading a
 * child's result off `callChildWorkflow`. "Terminal" = no outgoing 'main'
 * connection, i.e. nothing downstream of it in the graph. Deliberately
 * simple: real n8n's own `buildSubWorkflowOutput` has a configurable
 * merge-vs-last-run `returnOutput` setting; this always concatenates every
 * terminal node's own output (index-by-index across each node's outputs)
 * rather than picking one arbitrarily or silently dropping data.
 */
function terminalOutputItems(
  connections: IConnections,
  completed: Map<string, CompletedNodeOutput>
): INodeExecutionData[][] {
  const terminalOutputs: INodeExecutionData[][][] = [];
  for (const [nodeName, result] of completed) {
    if (
      result.status === 'success' &&
      !hasOutgoingMainConnection(nodeName, connections)
    ) {
      terminalOutputs.push(result.outputItems);
    }
  }
  if (terminalOutputs.length === 0) return [[]];
  // noUncheckedIndexedAccess doesn't narrow on a `.length` check — the index
  // is provably safe here (just checked length === 1), so a non-null
  // assertion documents a proven invariant rather than papering over a
  // genuinely unknown case.
  if (terminalOutputs.length === 1) return terminalOutputs[0]!;
  const maxOutputs = Math.max(...terminalOutputs.map((o) => o.length));
  const merged: INodeExecutionData[][] = [];
  for (let i = 0; i < maxOutputs; i++) {
    merged.push(terminalOutputs.flatMap((o) => o[i] ?? []));
  }
  return merged;
}

/**
 * The deterministic seed for a graph this orchestrator resolved *itself* —
 * used only for a sub-workflow child, which has no real `WorkflowExecute`
 * instance behind it to have already seeded a trigger the way
 * run-durably.ts does for a top-level execution (see
 * `OrchestrationInput.seed`'s own doc comment). Mirrors
 * `recreateNodeExecutionStack`'s own "no incoming connections -> synthetic
 * `{ json: {} }` item" rule (packages/core's
 * partial-execution-utils/recreate-node-execution-stack.ts) for whichever
 * node(s) have no incoming main connection — normally just the trigger, but
 * this doesn't assume there's exactly one.
 */
function seedForResolvedGraph(
  nodes: INode[],
  connections: IConnections
): OrchestrationInput['seed'] {
  const byDestination = mapConnectionsByDestination(connections);
  const seed: OrchestrationInput['seed'] = [];
  for (const node of nodes) {
    if (node.disabled) continue;
    const incoming = byDestination[node.name]?.['main'];
    const hasIncoming =
      incoming?.some((conns) => conns && conns.length > 0) ?? false;
    if (!hasIncoming) {
      seed.push({ nodeName: node.name, outputItems: [[{ json: {} }]] });
    }
  }
  return seed;
}

type PendingNode = {
  node: INode;
  inputItems: RunNodeInput['inputItems'];
  attempt: number;
};

/**
 * The deterministic half of the design: on every Dapr replay it rebuilds a
 * `DirectedGraph` from the static workflow snapshot it was scheduled with,
 * and calls n8n's own `recreateNodeExecutionStack` — the exact function
 * behind the editor's "resume from this node" feature — to decide which
 * nodes are ready, using only the connection graph and the results already
 * recorded. It never touches the database, the clock, or node code directly.
 *
 * Reuses n8n's own `recreateNodeExecutionStack` on every turn, fed the full
 * accumulated results so far, rather than hand-rolling incremental
 * ready-node-tracking.
 *
 * Declared `async function*`, not `function*`: the SDK's replay executor checks
 * for `Symbol.asyncIterator` specifically — a plain generator doesn't satisfy
 * it. The `: any` return annotation matches the SDK's own examples, which type
 * these functions loosely given the heterogeneous yield/return values the
 * generator protocol carries.
 *
 * Also the CHILD orchestration for an Execute Workflow node — see the
 * sub-workflow handling below. Recursion (a child that itself has a
 * sub-workflow) needs no extra code: it's just another invocation of this
 * same function, dispatched by ITS OWN orchestrator the same way.
 *
 * This is `orchestrator-v1` — see README's "Versioning discipline" section
 * for why this file is intentionally never touched once `orchestrator-v2.ts`
 * exists, and why that's a deliberate duplication, not an oversight.
 */
// `async function*`, not `function*`, is the contract: the SDK's replay
// executor checks for Symbol.asyncIterator specifically (a plain generator
// doesn't satisfy it), even though every real await here is a `yield`
// instead — hence require-await below. `: any` matches the SDK's own
// examples, which type these functions loosely given the heterogeneous
// yield/return values the generator protocol carries — hence
// no-explicit-any below.
//
// A block disable/enable pair, not `-next-line`: Prettier reflowing this
// function's parameter list onto multiple lines already moved the `: any`
// return annotation away from a line-anchored disable comment once — a block
// scope covering the whole function is immune to exactly that.
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-explicit-any */
export async function* runN8nNodeOrchestrator(
  ctx: WorkflowContext,
  input: OrchestrationInput
): any {
  const graph = filterDisabledNodes(
    DirectedGraph.fromNodesAndConnections(input.nodes, input.connections)
  );
  const totalNodes = graph.getNodes().size;
  const completed = new Map<string, CompletedNodeOutput>();

  // Seed whatever WorkflowExecute.run() already resolved before our patch ever
  // ran (see OrchestrationInput.seed / run-durably.ts) — the trigger node for a
  // normal manual run. Recorded as already-`success`-completed rather than
  // dispatched as an activity: trigger node types don't have an `execute()` to
  // call in the first place (see types.ts). This is frozen replay input, not a
  // clock read, so using constant timestamps here doesn't break determinism.
  for (const s of input.seed) {
    completed.set(s.nodeName, {
      status: 'success',
      nodeName: s.nodeName,
      runIndex: 0,
      startedAt: 0,
      finishedAt: 0,
      outputItems: s.outputItems,
    });
  }

  while (completed.size < totalNodes) {
    const candidates = new Set(
      [...graph.getNodes().values()].filter(
        (node: INode) => !completed.has(node.name)
      )
    );

    const { nodeExecutionStack } = recreateNodeExecutionStack(
      graph,
      candidates,
      toRunData(completed),
      {}
    );

    if (nodeExecutionStack.length === 0) {
      // Nothing is ready and not everything is done — either every remaining
      // branch is unreachable given what happened (e.g. an IF branch not taken),
      // or an upstream error means its children can never become ready. Either
      // way there's nothing left to schedule.
      break;
    }

    let pending: PendingNode[] = nodeExecutionStack.map((executeData) => ({
      node: executeData.node,
      // Each input index can individually be `null` (nothing connected, or a
      // connected branch that never ran — e.g. the untaken side of an IF) —
      // recreateNodeExecutionStack only guarantees the *required* inputs are
      // present, not every declared one. Normalize to `[]` per index so the
      // activity always gets a plain INodeExecutionData[][].
      inputItems: (executeData.data['main'] ?? []).map(
        (items: INodeExecutionData[] | null) => items ?? []
      ),
      attempt: 1,
    }));
    const roundResults = new Map<string, CompletedNodeOutput>();

    while (pending.length > 0) {
      // An Execute Workflow node must NEVER go through the generic activity
      // below — see sub-workflow.ts's own doc comment for exactly why: real
      // n8n's own executeWorkflow() (workflow-execute-additional-data.ts)
      // mints a brand-new execution id on every single call, with no way to
      // pass one in. If this node were dispatched through the generic
      // ledger-guarded activity like any other node, a crash while the
      // *first* attempt is still legitimately in flight (never returned, so
      // never ledger-cached) would, on redelivery, call executeWorkflow()
      // again — allocating a *different* child execution id and orphaning
      // the first child's still-durably-running Dapr orchestration rather
      // than resuming it. Split off before dispatching this round's regular
      // activities; handled entirely separately, below, using Dapr's own
      // child-workflow primitive instead.
      const subWorkflowPending = pending.filter(
        (p) => p.node.type === EXECUTE_WORKFLOW_NODE_TYPE
      );
      const regularPending = pending.filter(
        (p) => p.node.type !== EXECUTE_WORKFLOW_NODE_TYPE
      );

      const calls = regularPending.map((p) => {
        const activityInput: RunNodeInput = {
          instanceId: ctx.getWorkflowInstanceId(),
          nodeName: p.node.name,
          runIndex: 0,
          attempt: p.attempt,
          node: p.node,
          inputItems: p.inputItems,
          // Forwarded so the generic activity can skip incremental
          // execution-list progress syncing for a sub-workflow child the
          // same way this orchestrator already skips the final status sync
          // below — see types.ts's own doc comment on
          // RunNodeInput.isSubWorkflow.
          isSubWorkflow: input.isSubWorkflow,
        };
        return ctx.callActivity(ACTIVITY_NAME, activityInput);
      });

      // Zod-validated here, not trusted as a bare cast: this value is
      // replayed from Dapr's own history on every subsequent orchestrator
      // replay — exactly the "crosses the workflow boundary" case this
      // repo's Zod convention targets. Pure/synchronous, so safe to run
      // inside orchestrator code (no clock, no I/O, no randomness).
      const rawResults: unknown[] =
        regularPending.length > 0 ? yield ctx.whenAll(calls) : [];
      const results: RunNodeOutput[] = rawResults.map(
        (r) => runNodeOutputSchema.parse(r) as RunNodeOutput
      );

      const stillFailing: PendingNode[] = [];
      const waiting: Array<Extract<RunNodeOutput, { status: 'waiting' }>> = [];
      // `results` and `regularPending` are the same length by construction
      // (one activity call per pending node, one result per call from
      // `whenAll`) — the non-null assertions document that proven invariant
      // rather than papering over a genuinely unknown case
      // (noUncheckedIndexedAccess can't infer it from the loop bound alone).
      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        const p = regularPending[i]!;
        if (result.status === 'waiting') {
          // Already ran for real (see types.ts's RunNodeOutput doc) — must not
          // be re-dispatched as an activity. Handled below, once every result
          // in this round has been triaged.
          waiting.push(result);
          continue;
        }
        roundResults.set(result.nodeName, result);
        if (result.status === 'error' && p.attempt < RETRY_MAX_ATTEMPTS) {
          stillFailing.push({ ...p, attempt: p.attempt + 1 });
        }
      }

      // The orchestrator — never the activity — does the actual waiting,
      // racing a durable timer against an external event exactly the way
      // real n8n's own WaitTracker (time-based polling) and webhook resume
      // (event-based) are two independent ways the SAME waiting execution
      // can continue. Once either resolves, the node is done, with the
      // output it already produced before it asked to wait — it is not
      // re-executed.
      for (const w of waiting) {
        yield ctx.whenAny([
          ctx.createTimer(new Date(w.waitTill)),
          ctx.waitForExternalEvent(RESUME_EVENT_PREFIX + w.nodeName),
        ]);
        roundResults.set(w.nodeName, {
          status: 'success',
          nodeName: w.nodeName,
          runIndex: w.runIndex,
          startedAt: w.startedAt,
          finishedAt: w.finishedAt,
          outputItems: w.outputItems,
        });
      }

      // Resolve the target workflow, then dispatch it as a genuine Dapr
      // child workflow — one node at a time (sequential yields), not folded
      // into the whenAll batch above; this pass doesn't need concurrent
      // sub-workflow dispatch, and keeping it separate is simpler to reason
      // about. No retry loop for these, unlike regular nodes:
      // TODO(n8n-integration): a failed resolve or a failed child is
      // recorded as this node's own error directly on the first attempt,
      // not retried by this orchestrator's own backoff logic.
      for (const p of subWorkflowPending) {
        let workflowId: string;
        try {
          workflowId = getSubWorkflowId(p.node);
        } catch (err) {
          roundResults.set(p.node.name, {
            status: 'error',
            nodeName: p.node.name,
            runIndex: 0,
            startedAt: 0,
            finishedAt: 0,
            message: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        const resolveInput: ResolveSubWorkflowInput = { workflowId };
        const rawResolved: unknown = yield ctx.callActivity(
          RESOLVE_SUB_WORKFLOW_ACTIVITY_NAME,
          resolveInput
        );
        const resolved: ResolveSubWorkflowOutput =
          resolveSubWorkflowOutputSchema.parse(
            rawResolved
          ) as unknown as ResolveSubWorkflowOutput;
        if (!resolved.ok) {
          roundResults.set(p.node.name, {
            status: 'error',
            nodeName: p.node.name,
            runIndex: 0,
            startedAt: 0,
            finishedAt: 0,
            message: resolved.message,
          });
          continue;
        }

        const childInput: OrchestrationInput = {
          nodes: resolved.nodes,
          connections: resolved.connections,
          seed: seedForResolvedGraph(resolved.nodes, resolved.connections),
          isSubWorkflow: true,
        };

        // No explicit instance id: the SDK auto-generates one deterministically
        // from the parent's instance id and this call's sequence number
        // (`${parentInstanceId}:${seq.toString(16).padStart(4,'0')}` —
        // confirmed against the real SDK source,
        // runtime-orchestration-context.ts's `callSubOrchestrator`, which is
        // what `WorkflowContext.callChildWorkflow` calls into — confirmed
        // identical in the exact `@dapr/dapr` version this package now
        // depends on, not just in the checkout it was first proven against;
        // see README). A replay reaching this same call in the same
        // position resolves the *same* child rather than minting a new one —
        // this is the actual fix, not a side effect of using Dapr child
        // workflows generically.
        const rawChildResult: unknown = yield ctx.callChildWorkflow(
          ORCHESTRATOR_NAME,
          childInput
        );
        const childResult: OrchestratorResult = orchestratorResultSchema.parse(
          rawChildResult
        ) as OrchestratorResult;

        if (childResult.status === 'success') {
          roundResults.set(p.node.name, {
            status: 'success',
            nodeName: p.node.name,
            runIndex: 0,
            startedAt: 0,
            finishedAt: 0,
            outputItems: childResult.outputItems,
          });
        } else {
          roundResults.set(p.node.name, {
            status: 'error',
            nodeName: p.node.name,
            runIndex: 0,
            startedAt: 0,
            finishedAt: 0,
            message: `sub-workflow "${workflowId}" failed at node "${childResult.failedNode}": ${childResult.message}`,
          });
        }
      }

      if (stillFailing.length > 0) {
        // Just checked length > 0 above — provably non-null.
        yield ctx.createTimer(backoffSeconds(stillFailing[0]!.attempt - 1));
      }
      pending = stillFailing;
    }

    for (const [name, result] of roundResults) {
      completed.set(name, result);
    }
    const failed = [...roundResults.values()].find(
      (r): r is RunNodeOutput & { status: 'error' } => r.status === 'error'
    );
    if (failed) {
      // Dispatched as an activity, not called directly from run-durably.ts —
      // see execution-status-sync.ts's own doc comment for exactly why that
      // distinction is the fix: this is the only place in the whole design
      // guaranteed to run in *some* live process regardless of whether the
      // *original* process that scheduled this orchestration survived to see
      // it finish.
      //
      // Skipped entirely for a sub-workflow child (`isSubWorkflow`) — this
      // activity writes to n8n's own `execution_entity` table keyed by
      // `ctx.getWorkflowInstanceId()`, and a child's instance id is Dapr's
      // own auto-generated `${parentInstanceId}:XXXX`, not a real n8n
      // execution id.
      if (!input.isSubWorkflow) {
        const syncInput: SyncExecutionStatusInput = {
          executionId: ctx.getWorkflowInstanceId(),
          status: 'error',
          errorMessage: failed.message,
        };
        yield ctx.callActivity(SYNC_EXECUTION_STATUS_ACTIVITY_NAME, syncInput);
      }
      const result: OrchestratorResult = {
        status: 'error',
        failedNode: failed.nodeName,
        message: failed.message,
      };
      return result;
    }
  }

  if (!input.isSubWorkflow) {
    const syncInput: SyncExecutionStatusInput = {
      executionId: ctx.getWorkflowInstanceId(),
      status: 'success',
    };
    yield ctx.callActivity(SYNC_EXECUTION_STATUS_ACTIVITY_NAME, syncInput);
  }
  const result: OrchestratorResult = {
    status: 'success',
    nodeCount: completed.size,
    nodes: [...completed.keys()],
    outputItems: terminalOutputItems(input.connections, completed),
  };
  return result;
}
/* eslint-enable @typescript-eslint/require-await, @typescript-eslint/no-explicit-any */

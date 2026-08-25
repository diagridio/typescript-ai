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
  LOG_ROUND_START_ACTIVITY_NAME,
  ORCHESTRATOR_NAME_V2,
  RESOLVE_SUB_WORKFLOW_ACTIVITY_NAME,
  RESUME_EVENT_PREFIX,
  SYNC_EXECUTION_STATUS_ACTIVITY_NAME,
} from './constants';
import type { SyncExecutionStatusInput } from './execution-status-sync';
import type { LogRoundStartInput } from './round-log';
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

/**
 * Versioning discipline, proven for real (see README): this file is a
 * DELIBERATE, near-total duplicate of orchestrator.ts (v1). Duplicating the
 * whole file, rather than sharing the body through a parameterized helper,
 * is intentional — it's the most literal way to guarantee v1's registered
 * function is genuinely byte-for-byte unmodified, which is the entire point
 * of the proof this file exists for. A real rolling deploy looks exactly
 * like this: two versions of the same file, briefly coexisting, registered
 * under distinct names in the SAME running process (runtime.ts registers
 * both `ORCHESTRATOR_NAME` and `ORCHESTRATOR_NAME_V2` unconditionally) so
 * that whichever name an in-flight instance's own history already committed
 * to keeps resolving correctly, while new work moves to the new name.
 * Confirmed against the real `@dapr/dapr` source (not assumed):
 * `OrchestrationExecutor` resolves the orchestrator function by looking up
 * the *persisted* name from the instance's own `ExecutionStarted` history
 * event against the CURRENT process's registry, on every single
 * replay/resume — see README.
 *
 * THE ONE REAL, MEANINGFULLY DIFFERENT CHANGE (not cosmetic — it changes the
 * yield sequence, which is exactly what makes this a genuine test of the
 * discipline): v2 dispatches a new activity
 * (LOG_ROUND_START_ACTIVITY_NAME/round-log.ts) at the start of every dispatch
 * round, logging which nodes are about to run — a real, plausible
 * observability improvement a maintainer might actually ship (round-by-round
 * progress in log aggregation, not just the final per-node markers). v1's
 * history has no such call recorded. A v1 instance replayed under v2's code
 * would reach this new `yield` where its own history instead has whatever
 * the ORIGINAL next step was — a real, replay-breaking mismatch, not a
 * hypothetical one. See this file's marked "v2 CHANGE" comment below for the
 * exact line.
 *
 * Everything else below is deliberately identical to orchestrator.ts, save
 * for the two renames this fork structurally requires: the exported function
 * name (runN8nNodeOrchestratorV2) and the name a sub-workflow child recurses
 * into (ORCHESTRATOR_NAME_V2, not ORCHESTRATOR_NAME) — a child of a v2
 * orchestration should itself run as v2, the same "recursion needs no extra
 * code, it's just another invocation of this same function" property this
 * package's sub-workflow support already relied on, now applied per-version.
 */

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

function hasOutgoingMainConnection(
  nodeName: string,
  connections: IConnections
): boolean {
  const outputs = connections[nodeName]?.['main'];
  return outputs?.some((conns) => conns && conns.length > 0) ?? false;
}

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
  // is provably safe here (just checked length === 1).
  if (terminalOutputs.length === 1) return terminalOutputs[0]!;
  const maxOutputs = Math.max(...terminalOutputs.map((o) => o.length));
  const merged: INodeExecutionData[][] = [];
  for (let i = 0; i < maxOutputs; i++) {
    merged.push(terminalOutputs.flatMap((o) => o[i] ?? []));
  }
  return merged;
}

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

// Same async-generator/loose-return-type contract as orchestrator.ts's
// identical function — see its own comment just above the matching block
// disable there (a block, not `-next-line`: immune to Prettier reflowing the
// parameter list and moving the `: any` annotation away from a
// line-anchored comment, a real failure mode this file hit once already).
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-explicit-any */
export async function* runN8nNodeOrchestratorV2(
  ctx: WorkflowContext,
  input: OrchestrationInput
): any {
  const graph = filterDisabledNodes(
    DirectedGraph.fromNodesAndConnections(input.nodes, input.connections)
  );
  const totalNodes = graph.getNodes().size;
  const completed = new Map<string, CompletedNodeOutput>();

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

  let roundIndex = 0; // v2 CHANGE: tracked only to label the new round-start log call below.

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
      break;
    }

    let pending: PendingNode[] = nodeExecutionStack.map((executeData) => ({
      node: executeData.node,
      inputItems: (executeData.data['main'] ?? []).map((items) => items ?? []),
      attempt: 1,
    }));
    const roundResults = new Map<string, CompletedNodeOutput>();

    // v2 CHANGE — the one real, meaningfully different addition to the yield
    // sequence versus v1 (see this file's top-of-file doc comment): logs which
    // nodes are about to be dispatched this round, via a new dedicated
    // activity. v1's history has no TaskScheduled event for this call at this
    // position, so a v1 instance replayed under this code would mismatch
    // right here — proving the versioning discipline actually matters, not
    // just asserting it.
    const roundLogInput: LogRoundStartInput = {
      instanceId: ctx.getWorkflowInstanceId(),
      round: roundIndex++,
      nodeNames: pending.map((p) => p.node.name),
    };
    yield ctx.callActivity(LOG_ROUND_START_ACTIVITY_NAME, roundLogInput);

    while (pending.length > 0) {
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
          isSubWorkflow: input.isSubWorkflow,
        };
        return ctx.callActivity(ACTIVITY_NAME, activityInput);
      });

      const rawResults: unknown[] =
        regularPending.length > 0 ? yield ctx.whenAll(calls) : [];
      const results: RunNodeOutput[] = rawResults.map(
        (r) => runNodeOutputSchema.parse(r) as RunNodeOutput
      );

      const stillFailing: PendingNode[] = [];
      const waiting: Array<Extract<RunNodeOutput, { status: 'waiting' }>> = [];
      // `results` and `regularPending` are the same length by construction —
      // see orchestrator.ts's identical comment.
      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        const p = regularPending[i]!;
        if (result.status === 'waiting') {
          waiting.push(result);
          continue;
        }
        roundResults.set(result.nodeName, result);
        if (result.status === 'error' && p.attempt < RETRY_MAX_ATTEMPTS) {
          stillFailing.push({ ...p, attempt: p.attempt + 1 });
        }
      }

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

        // v2's own recursion target: ORCHESTRATOR_NAME_V2, not
        // ORCHESTRATOR_NAME — a child of a v2 orchestration runs as v2 too.
        // Otherwise identical to v1's callChildWorkflow usage (see
        // orchestrator.ts's own comment on why no explicit instance id is
        // passed).
        const rawChildResult: unknown = yield ctx.callChildWorkflow(
          ORCHESTRATOR_NAME_V2,
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

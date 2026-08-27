// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Drives `runN8nNodeOrchestrator` (v1) directly, the same way
 * `tests/core/agent/workflow.test.ts` drives `agentWorkflow`: the
 * orchestrator is a plain generator, so each `yield` can be answered by hand
 * with whatever Dapr would have replayed from history, with no sidecar and
 * no real n8n process. That makes branching, retry, waiting, and
 * sub-workflow dispatch — the paths a live e2e run only ever exercises one
 * at a time — all independently, repeatably testable.
 *
 * REQUIRES A LINKED SIBLING N8N CHECKOUT TO RUN, unlike `schemas.test.ts`/
 * `task-data.test.ts` in this same directory. `orchestrator.ts` imports
 * `DirectedGraph`/`filterDisabledNodes`/`recreateNodeExecutionStack` from
 * `n8n-core` as real VALUES (not just types) — the deterministic replay
 * itself is built on n8n's own graph-traversal code, not a reimplementation
 * of it, so there is no way to exercise the real thing without the real
 * dependency. Run `N8N_CHECKOUT=/path/to/n8n
 * packages/n8n/scripts/link-n8n-dev-deps.sh` first — see
 * `packages/n8n/README.md`'s own Scope section for why this package, unique
 * in this workspace, needs that for typecheck and for this file alike.
 */

import { describe, expect, it } from 'vitest';

import type { WorkflowContext } from '@diagrid/agent-core';

import {
  ACTIVITY_NAME,
  EXECUTE_WORKFLOW_NODE_TYPE,
  RESOLVE_SUB_WORKFLOW_ACTIVITY_NAME,
  SYNC_EXECUTION_STATUS_ACTIVITY_NAME,
} from '../../packages/n8n/src/constants';
import { runN8nNodeOrchestrator } from '../../packages/n8n/src/orchestrator';
import type {
  OrchestrationInput,
  OrchestratorResult,
  RunNodeOutput,
} from '../../packages/n8n/src/types';

/**
 * A minimal, real `INode` — fills in the boilerplate `id`/`position` every
 * fixture below needs. `INode` itself is derived from `OrchestrationInput`
 * (already imported from `packages/n8n/src/types`, below) rather than
 * imported directly from `n8n-workflow` here: this file lives under
 * `tests/n8n/`, which has no ancestor `node_modules` containing the sibling
 * checkout's symlinks (only `packages/n8n/` does — see
 * `scripts/link-n8n-dev-deps.sh`) — a bare `import type { INode } from
 * 'n8n-workflow'` from THIS file's own location fails to resolve even though
 * the exact same import inside `packages/n8n/src/types.ts` resolves fine
 * relative to ITS location.
 */
function node(overrides: {
  name: string;
  type: string;
  typeVersion: number;
  parameters?: OrchestrationInput['nodes'][number]['parameters'];
}): OrchestrationInput['nodes'][number] {
  return {
    id: `test-node-${overrides.name}`,
    position: [0, 0],
    parameters: {},
    ...overrides,
  };
}

interface RecordedCall {
  readonly kind: 'activity' | 'whenAll' | 'childWorkflow' | 'timer' | 'event';
  /** The activity name (e.g. `ACTIVITY_NAME`) — every task in a `whenAll` batch shares one. */
  readonly name?: string | undefined;
  readonly input?: unknown;
  /** Every batched task's own activity name — always `[ACTIVITY_NAME, ACTIVITY_NAME, ...]` for regular nodes. */
  readonly names?: string[] | undefined;
  /** Every batched task's `RunNodeInput.nodeName` — what actually varies per node in a round. */
  readonly nodeNames?: string[] | undefined;
}

/**
 * A scripted response queue: each `whenAll` yield consumes the next entry as
 * a whole (an array, one result per activity in that batch); each single
 * `callActivity`/`callChildWorkflow` yield consumes the next entry as one
 * value. `createTimer`/`whenAny`/`waitForExternalEvent` never consume the
 * script — they resolve immediately, mirroring how the existing
 * `agentWorkflow` driver treats a backoff timer.
 */
function driveOrchestrator(
  input: OrchestrationInput,
  // Each entry is either a single value (for a single callActivity/
  // callChildWorkflow yield) or an array (for a whenAll batch) — `unknown`
  // alone covers both, since an array is itself a valid `unknown`.
  script: readonly unknown[]
): { resultPromise: Promise<OrchestratorResult>; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let scriptIndex = 0;
  const nextScripted = (): unknown => {
    if (scriptIndex >= script.length) {
      throw new Error(
        `orchestrator requested response #${scriptIndex + 1} but only ${script.length} were scripted`
      );
    }
    return script[scriptIndex++];
  };

  // Each `ctx` method returns a tagged, inert descriptor — the real
  // resolution happens below, driven by what the generator actually yields,
  // not by anything these closures compute themselves.
  const ctx = {
    getWorkflowInstanceId: () => 'test-instance-1',
    callActivity: (name: unknown, activityInput?: unknown) => ({
      __kind: 'activity',
      name: String(name),
      input: activityInput,
    }),
    whenAll: (tasks: readonly { __kind: string; name: string }[]) => ({
      __kind: 'whenAll',
      tasks,
    }),
    whenAny: () => ({ __kind: 'whenAny' }),
    createTimer: () => ({ __kind: 'timer' }),
    waitForExternalEvent: (name: string) => ({ __kind: 'event', name }),
    callChildWorkflow: (name: unknown, childInput?: unknown) => ({
      __kind: 'childWorkflow',
      name: String(name),
      input: childInput,
    }),
  } as unknown as WorkflowContext;

  async function run(): Promise<OrchestratorResult> {
    const generator = runN8nNodeOrchestrator(ctx, input) as AsyncGenerator<
      unknown,
      OrchestratorResult,
      unknown
    >;
    let step = await generator.next();

    while (!step.done) {
      const yielded = step.value as {
        __kind: string;
        name?: string | undefined;
        input?: unknown;
        tasks?: readonly { name: string }[] | undefined;
      };

      let resolved: unknown;
      switch (yielded.__kind) {
        case 'timer':
          calls.push({ kind: 'timer' });
          resolved = undefined;
          break;
        case 'event':
          calls.push({ kind: 'event', name: yielded.name });
          resolved = undefined;
          break;
        case 'whenAny':
          calls.push({ kind: 'event' });
          resolved = undefined;
          break;
        case 'whenAll':
          calls.push({
            kind: 'whenAll',
            names: (yielded.tasks ?? []).map((t) => t.name),
            nodeNames: (
              yielded.tasks as readonly { input?: { nodeName?: string } }[]
            ).map((t) => t.input?.nodeName ?? ''),
          });
          resolved = nextScripted();
          break;
        case 'activity':
          calls.push({
            kind: 'activity',
            name: yielded.name,
            input: yielded.input,
          });
          resolved = nextScripted();
          break;
        case 'childWorkflow':
          calls.push({
            kind: 'childWorkflow',
            name: yielded.name,
            input: yielded.input,
          });
          resolved = nextScripted();
          break;
        default:
          throw new Error(`unhandled yield kind: ${yielded.__kind}`);
      }

      step = await generator.next(resolved);
    }

    return step.value;
  }

  return { resultPromise: run(), calls };
}

const success = (
  nodeName: string,
  overrides: Partial<Extract<RunNodeOutput, { status: 'success' }>> = {}
): RunNodeOutput => ({
  status: 'success',
  nodeName,
  runIndex: 0,
  startedAt: 0,
  finishedAt: 1,
  outputItems: [[{ json: {} }]],
  ...overrides,
});

const failure = (nodeName: string, message = 'boom'): RunNodeOutput => ({
  status: 'error',
  nodeName,
  runIndex: 0,
  startedAt: 0,
  finishedAt: 1,
  message,
});

describe('runN8nNodeOrchestrator — linear happy path', () => {
  it('dispatches the single node, syncs status, and returns success', async () => {
    const input: OrchestrationInput = {
      nodes: [
        node({
          name: 'Trigger',
          type: 'n8n-nodes-base.manualTrigger',
          typeVersion: 1,
        }),
        node({ name: 'Set A', type: 'n8n-nodes-base.set', typeVersion: 3.4 }),
      ],
      connections: {
        Trigger: { main: [[{ node: 'Set A', type: 'main', index: 0 }]] },
      },
      seed: [{ nodeName: 'Trigger', outputItems: [[{ json: {} }]] }],
    };

    const { resultPromise, calls } = driveOrchestrator(input, [
      [success('Set A')], // whenAll batch for round 0
      undefined, // SYNC_EXECUTION_STATUS_ACTIVITY_NAME
    ]);

    const result = await resultPromise;

    expect(result).toMatchObject({
      status: 'success',
      nodeCount: 2,
      nodes: ['Trigger', 'Set A'],
    });
    expect(calls.filter((c) => c.kind === 'whenAll')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'whenAll')[0]?.nodeNames).toEqual([
      'Set A',
    ]);
    const syncCall = calls.find(
      (c) => c.name === SYNC_EXECUTION_STATUS_ACTIVITY_NAME
    );
    expect(syncCall?.input).toMatchObject({
      executionId: 'test-instance-1',
      status: 'success',
    });
  });

  it('rejects malformed replayed activity output at the boundary (Zod)', async () => {
    const input: OrchestrationInput = {
      nodes: [
        node({ name: 'Set A', type: 'n8n-nodes-base.set', typeVersion: 3.4 }),
      ],
      connections: {},
      seed: [],
    };

    const { resultPromise } = driveOrchestrator(input, [[{ nonsense: true }]]);

    await expect(resultPromise).rejects.toThrow();
  });
});

describe('runN8nNodeOrchestrator — branching', () => {
  it('dispatches fanned-out nodes in the same round via a single whenAll', async () => {
    const input: OrchestrationInput = {
      nodes: [
        node({
          name: 'Trigger',
          type: 'n8n-nodes-base.manualTrigger',
          typeVersion: 1,
        }),
        node({
          name: 'Branch A',
          type: 'n8n-nodes-base.set',
          typeVersion: 3.4,
        }),
        node({
          name: 'Branch B',
          type: 'n8n-nodes-base.set',
          typeVersion: 3.4,
        }),
      ],
      connections: {
        Trigger: {
          main: [
            [
              { node: 'Branch A', type: 'main', index: 0 },
              { node: 'Branch B', type: 'main', index: 0 },
            ],
          ],
        },
      },
      seed: [{ nodeName: 'Trigger', outputItems: [[{ json: {} }]] }],
    };

    const { resultPromise, calls } = driveOrchestrator(input, [
      [success('Branch A'), success('Branch B')],
      undefined,
    ]);

    const result = await resultPromise;

    expect(result.status).toBe('success');
    const batch = calls.find((c) => c.kind === 'whenAll');
    expect([...(batch?.nodeNames ?? [])].sort()).toEqual([
      'Branch A',
      'Branch B',
    ]);
  });
});

describe('runN8nNodeOrchestrator — retry', () => {
  it('retries a failing node with a durable backoff timer between attempts, then succeeds', async () => {
    const input: OrchestrationInput = {
      nodes: [
        node({ name: 'Flaky', type: 'n8n-nodes-base.noOp', typeVersion: 1 }),
      ],
      connections: {},
      // No seed: Flaky has no incoming connection either, so
      // recreateNodeExecutionStack treats it as ready immediately — the same
      // way a trigger's direct successor would be once the trigger itself is
      // seeded.
      seed: [],
    };
    const { resultPromise, calls } = driveOrchestrator(input, [
      [failure('Flaky', 'attempt 1 failed')],
      [failure('Flaky', 'attempt 2 failed')],
      [success('Flaky')],
      undefined,
    ]);

    const result = await resultPromise;

    expect(result.status).toBe('success');
    const attempts = calls.filter((c) => c.kind === 'whenAll');
    expect(attempts).toHaveLength(3);
    // Each retry attempt carries an incremented `attempt` number, and a
    // durable timer (not a plain sleep) separates them.
    expect(calls.filter((c) => c.kind === 'timer')).toHaveLength(2);
  });

  it('fails the orchestration and syncs an error status once retries are exhausted', async () => {
    const input: OrchestrationInput = {
      nodes: [
        node({ name: 'Flaky', type: 'n8n-nodes-base.noOp', typeVersion: 1 }),
      ],
      connections: {},
      seed: [],
    };

    const { resultPromise, calls } = driveOrchestrator(input, [
      [failure('Flaky', 'still failing')],
      [failure('Flaky', 'still failing')],
      [failure('Flaky', 'still failing')],
      undefined, // SYNC_EXECUTION_STATUS_ACTIVITY_NAME (error path)
    ]);

    const result = await resultPromise;

    expect(result).toEqual({
      status: 'error',
      failedNode: 'Flaky',
      message: 'still failing',
    });
    const syncCall = calls.find(
      (c) => c.name === SYNC_EXECUTION_STATUS_ACTIVITY_NAME
    );
    expect(syncCall?.input).toMatchObject({
      status: 'error',
      errorMessage: 'still failing',
    });
  });
});

describe('runN8nNodeOrchestrator — Wait node', () => {
  it('races a timer/event, then records success using the already-produced output — no re-execution', async () => {
    const input: OrchestrationInput = {
      nodes: [
        node({ name: 'Wait', type: 'n8n-nodes-base.wait', typeVersion: 1.1 }),
      ],
      connections: {},
      seed: [],
    };
    const waiting: RunNodeOutput = {
      status: 'waiting',
      nodeName: 'Wait',
      runIndex: 0,
      startedAt: 0,
      finishedAt: 1,
      outputItems: [[{ json: { seen: true } }]],
      waitTill: Date.now() + 1000,
    };

    const { resultPromise, calls } = driveOrchestrator(input, [
      [waiting],
      undefined,
    ]);

    const result = await resultPromise;

    expect(result.status).toBe('success');
    // Exactly one activity dispatch for Wait — the wait's own resolution is
    // a ctx.whenAny race, not a second activity call.
    expect(calls.filter((c) => c.kind === 'whenAll')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'event')).toHaveLength(1);
  });
});

describe('runN8nNodeOrchestrator — sub-workflow', () => {
  it('resolves and dispatches an Execute Workflow node as a real child workflow, never through the generic activity', async () => {
    const input: OrchestrationInput = {
      nodes: [
        node({
          name: 'Execute Workflow',
          type: EXECUTE_WORKFLOW_NODE_TYPE,
          typeVersion: 1,
          parameters: { source: 'database', workflowId: 'child-wf-1' },
        }),
      ],
      connections: {},
      seed: [],
    };
    const childResult: OrchestratorResult = {
      status: 'success',
      nodeCount: 1,
      nodes: ['Child Set'],
      outputItems: [[{ json: { child: true } }]],
    };

    const { resultPromise, calls } = driveOrchestrator(input, [
      { ok: true, nodes: [], connections: {} }, // RESOLVE_SUB_WORKFLOW_ACTIVITY_NAME
      childResult, // ctx.callChildWorkflow
      undefined, // SYNC_EXECUTION_STATUS_ACTIVITY_NAME
    ]);

    const result = await resultPromise;

    expect(result).toMatchObject({
      status: 'success',
      outputItems: [[{ json: { child: true } }]],
    });
    // The Execute Workflow node must never appear in a whenAll batch — see
    // orchestrator.ts's own doc comment on why executeWorkflow() minting a
    // fresh execution id on every call makes the generic ledger-guarded
    // activity path unsafe for this node type.
    expect(calls.some((c) => c.kind === 'whenAll')).toBe(false);
    expect(
      calls.some((c) => c.name === RESOLVE_SUB_WORKFLOW_ACTIVITY_NAME)
    ).toBe(true);
    const child = calls.find((c) => c.kind === 'childWorkflow');
    expect(child?.name).toBe('diagrid.n8n.orchestrator-v1');
  });

  it('resolves a failed sub-workflow lookup into that node erroring the orchestration', async () => {
    const input: OrchestrationInput = {
      nodes: [
        node({
          name: 'Execute Workflow',
          type: EXECUTE_WORKFLOW_NODE_TYPE,
          typeVersion: 1,
          parameters: { source: 'database', workflowId: 'missing' },
        }),
      ],
      connections: {},
      seed: [],
    };

    const { resultPromise } = driveOrchestrator(input, [
      { ok: false, message: 'sub-workflow "missing" not found' },
      undefined,
    ]);

    const result = await resultPromise;

    expect(result).toEqual({
      status: 'error',
      failedNode: 'Execute Workflow',
      message: 'sub-workflow "missing" not found',
    });
  });
});

describe('runN8nNodeOrchestrator — isSubWorkflow', () => {
  it('skips SYNC_EXECUTION_STATUS_ACTIVITY_NAME entirely for a child orchestration', async () => {
    const input: OrchestrationInput = {
      nodes: [
        node({ name: 'Set A', type: 'n8n-nodes-base.set', typeVersion: 3.4 }),
      ],
      connections: {},
      seed: [],
      isSubWorkflow: true,
    };

    const { resultPromise, calls } = driveOrchestrator(input, [
      [success('Set A')],
    ]);

    const result = await resultPromise;

    expect(result.status).toBe('success');
    expect(
      calls.some((c) => c.name === SYNC_EXECUTION_STATUS_ACTIVITY_NAME)
    ).toBe(false);
  });
});

describe('runN8nNodeOrchestrator — activity name', () => {
  it('always dispatches regular nodes under the versioned generic activity name', async () => {
    const input: OrchestrationInput = {
      nodes: [
        node({ name: 'Set A', type: 'n8n-nodes-base.set', typeVersion: 3.4 }),
      ],
      connections: {},
      seed: [],
    };

    const { resultPromise, calls } = driveOrchestrator(input, [
      [success('Set A')],
      undefined,
    ]);
    await resultPromise;

    // The whenAll batch itself doesn't carry activity names on `calls` (only
    // the pre-batch `activity` records would, and regular nodes go through
    // whenAll) — assert on the underlying task descriptors instead via the
    // recorded whenAll entry's own `names`, which orchestrator.ts populates
    // from `ctx.callActivity(ACTIVITY_NAME, ...)` for every regular node.
    expect(calls.find((c) => c.kind === 'whenAll')?.names).toEqual([
      ACTIVITY_NAME,
    ]);
  });
});

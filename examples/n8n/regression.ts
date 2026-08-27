// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * A quick regression pass on everything `crash-recovery.ts` alone doesn't
 * exercise: branching/merge (concurrent activity dispatch within one
 * orchestrator round), a sub-workflow (a real Dapr child workflow), and node
 * retry (the orchestrator's durable backoff loop) — the same fixture shapes
 * `n8n-dapr-durable`'s own Phase 1/3 verification used, rebuilt here as an
 * automated, idempotent check rather than a manual walkthrough.
 *
 * Each fixture is created idempotently (by name) and triggered fresh on every
 * run, then polled to completion via n8n's real REST API. This intentionally
 * checks the same level of evidence `crash-recovery.ts` does (execution
 * `status`/`finished`) — not per-item output data, which n8n's REST API only
 * exposes as an opaque `flatted`-compressed blob (see that script's own doc
 * comment; the UI is the easier way to eyeball item data by hand).
 *
 * Usage: start a Dapr sidecar and a patched n8n process (see README.md), then
 *
 *   pnpm regression
 *
 * The retry check needs n8n started with the flaky-node fixture wired in —
 * see README.md's `regression.ts` section for the exact env vars. Without it,
 * this script still runs the branching and sub-workflow checks and reports
 * retry as skipped, rather than failing.
 */

import { existsSync, unlinkSync } from 'node:fs';

import { N8nClient, type WorkflowDefinition } from './n8n-client';
import { requireSidecar } from './sidecar';

const N8N_BASE_URL = process.env['N8N_BASE_URL'] ?? 'http://localhost:5678';

const BRANCHING_WORKFLOW: WorkflowDefinition = {
  name: 'diagrid-n8n-example-regression-branching',
  nodes: [
    {
      id: 't1',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    },
    {
      id: 'a1',
      name: 'Branch A',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [200, -80],
      parameters: {
        assignments: {
          assignments: [
            { id: '1', name: 'branchA', type: 'string', value: 'done' },
          ],
        },
        includeOtherFields: true,
        options: {},
      },
    },
    {
      id: 'a2',
      name: 'Branch B',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [200, 80],
      parameters: {
        assignments: {
          assignments: [
            { id: '1', name: 'branchB', type: 'string', value: 'done' },
          ],
        },
        includeOtherFields: true,
        options: {},
      },
    },
    // The exact fixture shape from n8n-nodes-base's own Merge v3 builder-hint
    // documentation (Merge/v3/actions/versionDescription.ts) — "append" is
    // its simplest mode: concatenate items from parallel branches, no
    // field-matching configuration needed.
    {
      id: 'm1',
      name: 'Merge',
      type: 'n8n-nodes-base.merge',
      typeVersion: 3.2,
      position: [420, 0],
      parameters: { mode: 'append', numberInputs: 2 },
    },
  ],
  connections: {
    'Manual Trigger': {
      main: [
        [
          { node: 'Branch A', type: 'main', index: 0 },
          { node: 'Branch B', type: 'main', index: 0 },
        ],
      ],
    },
    'Branch A': { main: [[{ node: 'Merge', type: 'main', index: 0 }]] },
    'Branch B': { main: [[{ node: 'Merge', type: 'main', index: 1 }]] },
  },
  settings: { executionOrder: 'v1' },
};

const SUBWORKFLOW_CHILD: WorkflowDefinition = {
  name: 'diagrid-n8n-example-regression-child',
  nodes: [
    {
      id: 'ct1',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    },
    {
      id: 'cs1',
      name: 'Child Set',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [200, 0],
      parameters: {
        assignments: {
          assignments: [
            { id: '1', name: 'childField', type: 'string', value: 'reached' },
          ],
        },
        includeOtherFields: true,
        options: {},
      },
    },
  ],
  connections: {
    'Manual Trigger': {
      main: [[{ node: 'Child Set', type: 'main', index: 0 }]],
    },
  },
  settings: { executionOrder: 'v1' },
};

function subworkflowParentDefinition(
  childWorkflowId: string
): WorkflowDefinition {
  return {
    name: 'diagrid-n8n-example-regression-parent',
    nodes: [
      {
        id: 'pt1',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'pe1',
        name: 'Execute Workflow',
        // typeVersion 1: `workflowId` is a plain string (source: 'database'
        // is the default at this version) — see sub-workflow.ts's own doc
        // comment on why only a literal id, no expressions, is supported.
        type: 'n8n-nodes-base.executeWorkflow',
        typeVersion: 1,
        position: [200, 0],
        parameters: { source: 'database', workflowId: childWorkflowId },
      },
      {
        id: 'pn1',
        // A Set node, deliberately not NoOp: fixtures/flaky-node.cjs
        // overrides the 'n8n-nodes-base.noOp' type GLOBALLY for the whole
        // process whenever it's wired in (see that file's own doc comment)
        // — a terminal node here named/typed NoOp would silently become
        // flaky too, sharing checkRetry's own counter file. Confirmed by
        // actually hitting this: an earlier version of this fixture used
        // NoOp and this node genuinely retried twice before succeeding,
        // which is a real proof the orchestrator's retry loop works
        // correctly for a sub-workflow's own downstream node too, but not a
        // deliberate, repeatable one — this fixture's own pass/fail should
        // not depend on whether a DIFFERENT check's fixture happens to be
        // co-loaded.
        name: 'Parent Set',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [400, 0],
        parameters: {
          assignments: {
            assignments: [
              {
                id: '1',
                name: 'parentField',
                type: 'string',
                value: 'reached',
              },
            ],
          },
          includeOtherFields: true,
          options: {},
        },
      },
    ],
    connections: {
      'Manual Trigger': {
        main: [[{ node: 'Execute Workflow', type: 'main', index: 0 }]],
      },
      'Execute Workflow': {
        main: [[{ node: 'Parent Set', type: 'main', index: 0 }]],
      },
    },
    settings: { executionOrder: 'v1' },
  };
}

const RETRY_WORKFLOW: WorkflowDefinition = {
  name: 'diagrid-n8n-example-regression-retry',
  nodes: [
    {
      id: 'rt1',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    },
    {
      id: 'rf1',
      name: 'Flaky',
      // A real, n8n-recognized type (see fixtures/flaky-node.cjs's own doc
      // comment for why it deliberately reuses NoOp's type name rather than
      // inventing one n8n's own pre-execution validation would reject).
      type: 'n8n-nodes-base.noOp',
      typeVersion: 1,
      position: [200, 0],
      parameters: {},
    },
  ],
  connections: {
    'Manual Trigger': { main: [[{ node: 'Flaky', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
};

interface CheckResult {
  readonly name: string;
  readonly outcome: 'pass' | 'fail' | 'skip';
  readonly detail: string;
}

async function checkBranching(client: N8nClient): Promise<CheckResult> {
  const workflowId = await client.findOrCreateWorkflow(BRANCHING_WORKFLOW);
  const executionId = await client.trigger(workflowId);
  const execution = await client.waitForCompletion(executionId);
  return execution.status === 'success'
    ? {
        name: 'branching (fan-out/fan-in via Merge)',
        outcome: 'pass',
        detail: `execution ${executionId} succeeded`,
      }
    : {
        name: 'branching (fan-out/fan-in via Merge)',
        outcome: 'fail',
        detail: `execution ${executionId} ended with status "${execution.status}"`,
      };
}

async function checkSubWorkflow(client: N8nClient): Promise<CheckResult> {
  const childId = await client.findOrCreateWorkflow(SUBWORKFLOW_CHILD);
  const parentId = await client.findOrCreateWorkflow(
    subworkflowParentDefinition(childId)
  );
  const executionId = await client.trigger(parentId);
  const execution = await client.waitForCompletion(executionId);
  return execution.status === 'success'
    ? {
        name: 'sub-workflow (Execute Workflow -> real Dapr child workflow)',
        outcome: 'pass',
        detail: `parent execution ${executionId} succeeded (child workflow ${childId})`,
      }
    : {
        name: 'sub-workflow (Execute Workflow -> real Dapr child workflow)',
        outcome: 'fail',
        detail: `parent execution ${executionId} ended with status "${execution.status}"`,
      };
}

async function checkRetry(client: N8nClient): Promise<CheckResult> {
  const counterFile = process.env['DIAGRID_N8N_FLAKY_COUNTER_FILE'];
  if (!counterFile) {
    return {
      name: 'retry (durable backoff on a failing node)',
      outcome: 'skip',
      detail:
        'DIAGRID_N8N_FLAKY_COUNTER_FILE is not set — n8n was not started with ' +
        'fixtures/flaky-node.cjs wired in (see README.md). Skipping, not failing.',
    };
  }
  // Reset: the counter is a plain file, shared across every run of this
  // script and every n8n boot that points at it — without resetting, a
  // second run would find the counter already past `failCount` and the node
  // would succeed on attempt 1, exercising nothing.
  if (existsSync(counterFile)) unlinkSync(counterFile);

  const workflowId = await client.findOrCreateWorkflow(RETRY_WORKFLOW);
  const executionId = await client.trigger(workflowId);
  // The default backoff schedule is 2s/4s (constants.ts's backoffSeconds),
  // plus n8n/Dapr round-trip overhead — 30s is generous headroom for 2
  // failures + 1 success.
  const execution = await client.waitForCompletion(executionId, {
    timeoutMs: 30_000,
  });
  return execution.status === 'success'
    ? {
        name: 'retry (durable backoff on a failing node)',
        outcome: 'pass',
        detail: `execution ${executionId} succeeded after the configured failures + backoff`,
      }
    : {
        name: 'retry (durable backoff on a failing node)',
        outcome: 'fail',
        detail: `execution ${executionId} ended with status "${execution.status}"`,
      };
}

async function main(): Promise<void> {
  const mode = requireSidecar('diagrid-example-n8n');
  console.log(`Sidecar: ${mode}`);

  const client = new N8nClient(N8N_BASE_URL);
  if (!(await client.healthy())) {
    console.error(
      `n8n is not reachable at ${N8N_BASE_URL}. Start it, patched, in a separate terminal first — see README.md.`
    );
    process.exit(1);
  }
  await client.ensureLoggedIn();

  const results: CheckResult[] = [];
  results.push(await checkBranching(client));
  results.push(await checkSubWorkflow(client));
  results.push(await checkRetry(client));

  console.log('\n' + '='.repeat(60));
  for (const result of results) {
    const icon =
      result.outcome === 'pass'
        ? '✅'
        : result.outcome === 'skip'
          ? '⚠️ '
          : '❌';
    console.log(`${icon} ${result.name}\n   ${result.detail}`);
  }
  console.log('='.repeat(60));

  if (results.some((r) => r.outcome === 'fail')) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

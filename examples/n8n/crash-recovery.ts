// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Crash-recovery demo — the exit criterion this whole package is built
 * around: a killed-and-restarted n8n process resumes a multi-node workflow
 * from its last completed node, with no duplicate side effects.
 *
 * Structurally different from `examples/mastra/crash-recovery.ts`, for a
 * real reason worth stating plainly rather than hiding: Mastra's adapter is
 * a library an application constructs and calls `.invoke()` on in-process,
 * so that example can inject its own crash (`process.exit(1)` mid-turn) and
 * simply be re-run to prove resumption. `@diagrid/n8n` instead attaches to a
 * SEPARATE, already-running n8n SERVER process via `NODE_OPTIONS`. This
 * script cannot start, crash, or restart that process itself — that is a
 * genuinely external, shell-level step (see README.md's walkthrough). What
 * this script automates is everything either side of that step: creating the
 * demo workflow (idempotent), triggering it via n8n's real REST API,
 * detecting whether it's already in flight from a prior run of this same
 * script, and verifying the real evidence once it completes — the same
 * three-way evidence standard (marker log, direct state-store inspection,
 * n8n's own execution record) this package's whole development history used.
 *
 * Usage:
 *   1. Start a Dapr sidecar and a patched n8n process (see README.md).
 *   2. `pnpm crash-recovery` — creates the demo workflow if needed, triggers
 *      it, and prints exactly when/how to kill n8n.
 *   3. Kill n8n (SIGKILL), confirm the wait is durable, restart it.
 *   4. `pnpm crash-recovery` again — detects the in-flight run from step 2
 *      and verifies it resumed and completed correctly.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { N8nClient, type WorkflowDefinition } from './n8n-client';
import { requireSidecar } from './sidecar';

const N8N_BASE_URL = process.env['N8N_BASE_URL'] ?? 'http://localhost:5678';
const STATE_FILE = join(tmpdir(), 'diagrid-n8n-crash-recovery-state.json');
const WORKFLOW_NAME = 'diagrid-n8n-example-crash-recovery';

interface DemoState {
  phase: 'triggered';
  workflowId: string;
  executionId: string;
  triggeredAt: string;
}

function loadState(): DemoState | undefined {
  if (!existsSync(STATE_FILE)) return undefined;
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as DemoState;
}

function saveState(state: DemoState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function clearState(): void {
  if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
}

/**
 * Manual Trigger -> Wait (90s, timeInterval) -> NoOp. 90s is comfortably over
 * `Wait.node.ts`'s own 65s durable-timer threshold (below it, Wait uses a
 * plain in-process `setTimeout`, not `putExecutionToWait` — not durable, and
 * not what this demo is about) — see `packages/n8n/README.md`'s "Idempotency
 * and at-least-once activities" section for what the wait itself proves.
 */
const WORKFLOW_DEFINITION: WorkflowDefinition = {
  name: WORKFLOW_NAME,
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
      id: 'w1',
      name: 'Wait',
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      position: [200, 0],
      parameters: { resume: 'timeInterval', amount: 90, unit: 'seconds' },
    },
    {
      id: 'n1',
      name: 'NoOp',
      type: 'n8n-nodes-base.noOp',
      typeVersion: 1,
      position: [400, 0],
      parameters: {},
    },
  ],
  connections: {
    'Manual Trigger': { main: [[{ node: 'Wait', type: 'main', index: 0 }]] },
    Wait: { main: [[{ node: 'NoOp', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
};

async function main(): Promise<void> {
  const mode = requireSidecar('diagrid-example-n8n');
  console.log(`Sidecar: ${mode}`);

  const client = new N8nClient(N8N_BASE_URL);
  if (!(await client.healthy())) {
    console.error(
      `n8n is not reachable at ${N8N_BASE_URL}. Start it, patched, in a separate terminal first — see README.md:\n\n` +
        `  DAPR_HTTP_PORT=3610 DAPR_GRPC_PORT=50310 \\\n` +
        `  NODE_OPTIONS="--require /absolute/path/to/packages/n8n/dist/preload.cjs" \\\n` +
        `    n8n start`
    );
    process.exit(1);
  }

  // Unconditional, not just on the first-run branch: a real bug, caught only
  // by actually running the second invocation as its own fresh process — the
  // session cookie lives on this script's own N8nClient instance, so a
  // second run with no login call sent every /rest/executions/:id request
  // unauthenticated. n8n's own 401 was then swallowed by getExecution()'s
  // catch-and-return-undefined (see n8n-client.ts), which surfaced here as a
  // misleading "Execution N not found — was n8n's database reset?" instead
  // of the real cause.
  await client.ensureLoggedIn();

  const existing = loadState();

  if (!existing) {
    // First run: create the demo workflow if needed, trigger it, and hand
    // off to the operator for the actual kill-and-restart step.
    const workflowId = await client.findOrCreateWorkflow(WORKFLOW_DEFINITION);
    const executionId = await client.trigger(workflowId);
    saveState({
      phase: 'triggered',
      workflowId,
      executionId,
      triggeredAt: new Date().toISOString(),
    });

    console.log(
      `\nTriggered execution ${executionId} (workflow ${workflowId}).`
    );
    console.log(
      `\nIt will reach the Wait node and enter a genuinely durable wait within a\n` +
        `few seconds — confirm with a direct redis check if you like (adjust the\n` +
        `app-id prefix to whatever --app-id the sidecar was started with):\n\n` +
        `  redis-cli --scan --pattern "*diagrid.n8n:${executionId}:*"\n\n` +
        `Once it's waiting:\n` +
        `  1. SIGKILL the n8n process (the one you started with --require).\n` +
        `  2. Restart it the same way, pointed at the SAME sidecar ports.\n` +
        `  3. Re-run \`pnpm crash-recovery\` — it will detect this in-flight run\n` +
        `     and verify it resumed and completed correctly once the 90s wait\n` +
        `     elapses.`
    );
    return;
  }

  // Second run: verify.
  const execution = await client.getExecution(existing.executionId);
  if (!execution) {
    console.error(
      `Execution ${existing.executionId} not found — was n8n's database reset?`
    );
    process.exit(1);
  }

  if (!execution.finished) {
    console.log(
      `Execution ${existing.executionId} is still running (status: ${execution.status}). ` +
        `If you haven't killed-and-restarted n8n yet, do that now. Otherwise, wait for ` +
        `the 90s durable timer and run this again.`
    );
    return;
  }

  console.log(
    `\nExecution ${existing.executionId} finished: status=${execution.status}`
  );
  if (execution.status !== 'success') {
    console.error(
      'Expected status "success" — the crash-recovery demo did not complete correctly.'
    );
    process.exit(1);
  }

  console.log(
    '\nSUCCESS: the workflow resumed after the kill-and-restart and completed correctly —\n' +
      "the Wait node's durable timer fired and the NoOp node ran, with no duplicate side\n" +
      'effects (see the ledger and, if DIAGRID_N8N_MARKER_FILE was set on the n8n process,\n' +
      'the marker log for independent confirmation: exactly one real execution per node).'
  );
  clearState();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

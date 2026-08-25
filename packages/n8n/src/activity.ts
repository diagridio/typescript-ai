// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import type { WorkflowActivityContext } from '@diagrid/agent-core';
import * as fs from 'node:fs';

import { executeNodeStandalone } from './execute-node';
import { syncNodeProgress } from './execution-progress';
import { readLedger, writeLedger } from './ledger';
import { runNodeInputSchema } from './schemas';
import { completedNodeOutputToTaskData } from './task-data';
import type { RunNodeInput, RunNodeOutput } from './types';

/**
 * Diagnostic-only, env-var gated: appends one JSON line per REAL node
 * execution (a ledger miss — i.e. `executeNodeStandalone` actually ran) to a
 * shared file. Deliberately does not fire on a ledger hit (Dapr redelivering
 * an already-completed attempt) — the whole point is to distinguish "the
 * activity was invoked" from "the node's side effect actually happened",
 * which is the signal a kill-and-resume proof needs: exactly one
 * real-execution line per node per attempt, even across a crash and restart.
 * Used by `examples/n8n/crash-recovery.ts` and the other verification
 * scripts under `examples/n8n/` — never set in normal operation.
 */
function appendMarker(
  input: RunNodeInput,
  status: RunNodeOutput['status']
): void {
  const sink = process.env['DIAGRID_N8N_MARKER_FILE'];
  if (!sink) return;
  const line = JSON.stringify({
    nodeName: input.nodeName,
    attempt: input.attempt,
    runIndex: input.runIndex,
    instanceId: input.instanceId,
    pid: process.pid,
    status,
    timestamp: new Date().toISOString(),
  });
  try {
    fs.appendFileSync(sink, line + '\n');
  } catch {
    // Diagnostic-only — never let logging failures affect real behavior.
  }
}

/**
 * Diagnostic-only, env-var gated: artificially slows down one named node's
 * real execution. Exists purely to widen the observation window for a
 * kill-and-resume proof (e.g. so there's time to confirm a node's activity is
 * genuinely in flight, and to SIGKILL the process, before it finishes) —
 * neither the node name nor the delay is hardcoded, both come from the
 * environment, so this has zero effect unless a test deliberately opts in.
 */
async function maybeDelay(nodeName: string): Promise<void> {
  if (nodeName !== process.env['DIAGRID_N8N_DELAY_NODE_NAME']) return;
  const ms = Number(process.env['DIAGRID_N8N_DELAY_MS'] ?? '0');
  if (!ms || ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Syncs one node's real, terminal outcome into n8n's own execution record
 * incrementally — see execution-progress.ts's own doc comment for the full
 * reasoning. Deliberately excludes two cases:
 *  - `isSubWorkflow`: a child's Dapr-generated instance id has no
 *    corresponding execution-list row — same boundary
 *    SYNC_EXECUTION_STATUS_ACTIVITY_NAME already draws.
 *  - `status: 'waiting'`: not a node "completion" in the sense this feature
 *    targets. TODO(n8n-integration): a Wait node's own eventual resolution
 *    is therefore never incrementally synced either — only whatever runs
 *    after it. See README.
 * Best-effort and never thrown from here: a failure must not fail the real
 * activity and cause a spurious retry of an already-succeeded side effect.
 */
async function maybeSyncProgress(
  input: RunNodeInput,
  result: RunNodeOutput
): Promise<void> {
  if (input.isSubWorkflow) return;
  if (result.status === 'waiting') return;
  await syncNodeProgress(
    input.instanceId,
    input.nodeName,
    completedNodeOutputToTaskData(result)
  );
}

/**
 * The one generic activity every n8n node type dispatches through — parameterized
 * by payload, not by name. The Dapr JS SDK's calling convention takes an
 * arbitrary-name string plus arbitrary JSON input, so this needs registering
 * exactly once regardless of how many distinct n8n node types get routed
 * through it at runtime.
 *
 * Runs inside a real n8n process (main or worker) with real DB/credential access
 * — this is the only place real side effects happen. The orchestrator that calls
 * this never sees or touches any of it directly.
 *
 * `rawInput` is Zod-validated before use: this activity's input is
 * constructed by the orchestrator and replayed from Dapr's own history on
 * every subsequent replay — exactly the "crosses the workflow boundary" case
 * this repo's Zod convention targets. See schemas.ts's own doc comment for
 * why the n8n-owned `node` field gets a proportionate, not exhaustive,
 * schema.
 */
export async function runN8nNodeActivity(
  _ctx: WorkflowActivityContext,
  rawInput: unknown
): Promise<RunNodeOutput> {
  // Through `unknown`: the Zod-inferred shape's `.passthrough()` fields (for
  // n8n-owned `INode` properties this package doesn't itself name, e.g. `id`,
  // `position`) don't "sufficiently overlap" INode's own required fields as
  // far as a direct `as` cast is concerned, even though they're preserved at
  // runtime — see schemas.ts's own doc comment on why `node` gets a
  // proportionate, not exhaustive, schema.
  const input = runNodeInputSchema.parse(rawInput) as unknown as RunNodeInput;

  const cached = await readLedger(
    input.instanceId,
    input.nodeName,
    input.runIndex,
    input.attempt
  );
  if (cached) return cached; // Dapr redelivered this exact attempt — the real work already happened once, don't repeat it.

  await maybeDelay(input.nodeName);

  const startedAt = Date.now(); // safe here: this is the activity, not the replayed orchestrator
  try {
    const execResult = await executeNodeStandalone(
      input.node,
      input.inputItems
    );
    const result: RunNodeOutput =
      execResult.status === 'waiting'
        ? {
            status: 'waiting',
            nodeName: input.nodeName,
            runIndex: input.runIndex,
            startedAt,
            finishedAt: Date.now(),
            outputItems: execResult.outputItems,
            waitTill: execResult.waitTill,
          }
        : {
            status: 'success',
            nodeName: input.nodeName,
            runIndex: input.runIndex,
            startedAt,
            finishedAt: Date.now(),
            outputItems: execResult.outputItems,
          };
    appendMarker(input, result.status);
    // A 'waiting' result must be ledger-cached exactly like success/error: a
    // redelivery of this same attempt must not re-run the node's execute() a
    // second time, which for a node like Wait would recompute a brand new
    // `waitTill` from `Date.now()` on each redelivery instead of honoring the
    // one it already committed to.
    await writeLedger(
      input.instanceId,
      input.nodeName,
      input.runIndex,
      input.attempt,
      result
    );
    await maybeSyncProgress(input, result);
    return result;
  } catch (err) {
    const result: RunNodeOutput = {
      status: 'error',
      nodeName: input.nodeName,
      runIndex: input.runIndex,
      startedAt,
      finishedAt: Date.now(),
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
    appendMarker(input, result.status);
    await writeLedger(
      input.instanceId,
      input.nodeName,
      input.runIndex,
      input.attempt,
      result
    );
    await maybeSyncProgress(input, result);
    return result;
  }
}

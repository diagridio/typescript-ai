// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import { Container } from '@n8n/di';
import type { ExecutionRepository as ExecutionRepositoryType } from '@n8n/db';
import { createRunExecutionData } from 'n8n-workflow';
import type { IRunExecutionData, ITaskData } from 'n8n-workflow';

/**
 * Execution-list parity via the ledger: syncs each node's real, terminal
 * outcome into n8n's own execution record incrementally, mirroring real
 * n8n's own opt-in `saveExecutionProgress`
 * (`packages/cli/src/execution-lifecycle/save-execution-progress.ts` in the
 * n8n checkout — read as this feature's reference implementation) — with one
 * real difference that reference doesn't have to solve.
 *
 * Real n8n's execution engine mutates a single shared `IRunExecutionData`
 * object in memory for an execution's entire lifetime, and its own
 * `executionLoop` awaits exactly one node at a time before moving to the next
 * (`workflow-execute.ts`'s own comment: "Await is needed to make sure that we
 * don't fall into concurrency problems... when saving node execution data").
 * Because of that, n8n's own save path never needs to re-read the current row
 * before writing (its caller already holds the full, current picture), and —
 * confirmed by reading the whole call path
 * (`ExecutionPersistence.updateExistingExecution` /`applyDataUpdate`) — has no
 * guard against two concurrent progress-saves racing each other's read of
 * `runData`; it only guards against saving progress onto an execution that's
 * already finished or canceled (`requireNotFinished`/`requireNotCanceled`).
 * n8n's own architecture makes the race this package actually faces
 * structurally impossible for it, which is why it never needed to solve it.
 *
 * This package has no such shared object: every node run is an isolated Dapr
 * activity invocation, and sibling branch nodes are routinely dispatched in
 * the same orchestrator round (`ctx.whenAll`) — real concurrency at the
 * JS-async-interleaving level, even within one process. A read-modify-write is
 * unavoidable (the `execution_data.data` column is one opaque
 * flatted-serialized TEXT blob, with no partial/JSON-path update reachable
 * from `@n8n/db`'s public surface, for either sqlite or Postgres), and so is a
 * real concurrency guard:
 *
 *  1. An in-process async mutex, keyed by execution id (`withExecutionLock`
 *     below). This is the mechanism actually relied upon, and it is a
 *     complete, correct fix for the only deployment shape this package has
 *     ever been run under so far: one n8n process, one Dapr runtime
 *     connection.
 *  2. A read-after-write verification, with a bounded retry, as defense in
 *     depth beyond that boundary.
 *
 * TODO(n8n-integration): this does NOT make the write safe across multiple OS
 * processes (e.g. a queue-mode deployment with several workers) — nothing
 * reachable through `@n8n/db` offers a real compare-and-swap on this column.
 * A queue-mode deployment remains untested; see README.
 *
 * LAZY-LOADED `@n8n/db` for the same reason execution-status-sync.ts and
 * sub-workflow.ts are: a top-level import pulls in `@n8n/typeorm` ->
 * `app-root-path`, which throws when loaded this early in the `--require`
 * preload chain.
 */

// Keyed per execution id: chains this execution's read-modify-write cycles so
// two concurrent calls for the SAME execution never interleave — calls for
// DIFFERENT executions are never serialized against each other, and the map
// never accumulates a permanent entry per execution (cleaned up below once
// nothing is queued behind it).
const executionLocks = new Map<string, Promise<void>>();

async function withExecutionLock<T>(
  executionId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prior = executionLocks.get(executionId) ?? Promise.resolve();
  let resolveOurs!: () => void;
  const ours = new Promise<void>((resolve) => {
    resolveOurs = resolve;
  });
  const ourLink = prior.then(() => ours);
  executionLocks.set(executionId, ourLink);
  await prior; // wait our turn
  try {
    return await fn();
  } finally {
    resolveOurs();
    // Only the last-in-line clears the entry — if someone queued behind us in
    // the meantime, `executionLocks.get(executionId)` no longer === ourLink.
    if (executionLocks.get(executionId) === ourLink) {
      executionLocks.delete(executionId);
    }
  }
}

/**
 * Fetches the execution's current `data`, merges in this one node's
 * `ITaskData` under `resultData.runData[nodeName]`, and writes the whole blob
 * back — see this module's own doc comment for why a read-modify-write (not
 * an atomic partial update) is unavoidable here.
 *
 * Best-effort, like `syncExecutionStatus`: this is an observability/UI-parity
 * improvement, not the source of truth for the workflow's own correctness
 * (the ledger is). A failure here must never fail the real activity — that
 * would spuriously retry a node's already-succeeded real side effect.
 */
export async function syncNodeProgress(
  executionId: string,
  nodeName: string,
  taskData: ITaskData
): Promise<void> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await withExecutionLock(executionId, async () => {
        const {
          ExecutionRepository,
        }: { ExecutionRepository: typeof ExecutionRepositoryType } =
          await import('@n8n/db');
        const executionRepository = Container.get(ExecutionRepository);

        const current = await executionRepository.findSingleExecution(
          executionId,
          {
            includeData: true,
            unflattenData: true,
          }
        );
        if (!current) {
          console.error(
            `@diagrid/n8n: syncNodeProgress found no execution row for ${executionId} ` +
              `(node "${nodeName}") — skipping.`
          );
          return;
        }

        // `current.data` is `undefined`, not a populated IRunExecutionData, for
        // the very first sync of a fresh execution: n8n's own `execution_data`
        // row starts out holding the placeholder flatted-empty-array string
        // ("[]") before anything has ever been saved to it, and
        // ExecutionRepository's own `handleExecutionRunData` (with
        // `unflattenData: true`) returns `undefined` when `parseFlatted(...)`
        // can't reconstruct a root object from that placeholder — confirmed by
        // hitting exactly this case empirically. `createRunExecutionData()` is
        // the same branded-type factory execution-status-sync.ts already uses,
        // here as a fallback base to merge onto rather than a final value.
        const baseData: IRunExecutionData =
          current.data ?? createRunExecutionData({});

        const data: IRunExecutionData = {
          ...baseData,
          resultData: {
            ...baseData.resultData,
            lastNodeExecuted: nodeName,
            runData: {
              ...baseData.resultData.runData,
              [nodeName]: [taskData],
            },
          },
        };

        const updated = await executionRepository.updateExistingExecution(
          executionId,
          { data }
        );
        if (!updated) {
          console.error(
            `@diagrid/n8n: syncNodeProgress's updateExistingExecution matched no row for ` +
              `${executionId} (node "${nodeName}").`
          );
          return;
        }

        // Defense-in-depth verification (see this module's own doc comment,
        // point 2) — the in-process lock above is what actually prevents a
        // same-process race; this makes a violation of that assumption FAIL
        // LOUDLY (a thrown, retried mismatch) instead of silently dropping a
        // node's progress.
        const verify = await executionRepository.findSingleExecution(
          executionId,
          {
            includeData: true,
            unflattenData: true,
          }
        );
        const persisted = verify?.data?.resultData?.runData[nodeName]?.[0];
        if (
          !persisted ||
          persisted.executionStatus !== taskData.executionStatus
        ) {
          throw new Error(
            `@diagrid/n8n: syncNodeProgress verification mismatch for execution ${executionId}, ` +
              `node "${nodeName}" — a concurrent writer may have raced this update.`
          );
        }
      });
      return; // success
    } catch (err) {
      if (attempt === maxAttempts) {
        // Best-effort: the ledger (not this) is the real source of truth for
        // the node's own outcome.
        console.error(
          `@diagrid/n8n: failed to sync node "${nodeName}"'s progress into execution ` +
            `${executionId}'s record after ${maxAttempts} attempts`,
          err
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 200));
    }
  }
}

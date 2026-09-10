// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import type { WorkflowActivityContext } from '@diagrid/agent-core';
import { Container } from '@n8n/di';
import type { ExecutionRepository as ExecutionRepositoryType } from '@n8n/db';
import { createRunExecutionData, WorkflowOperationError } from 'n8n-workflow';
import type { ExecutionError, IRunExecutionData } from 'n8n-workflow';

import { syncExecutionStatusInputSchema } from './schemas';

/**
 * Directly updates n8n's own execution record via the same DI-registered
 * repository n8n's own lifecycle hooks use. `Container.get(...)` resolves
 * against *whatever process calls this* own DI container — which n8n
 * bootstraps fresh on every boot, independent of any particular execution.
 *
 * Confirmed reachable without any upstream n8n change: `@n8n/db` is a real,
 * independently-versioned workspace package (packages/@n8n/db/package.json —
 * its own name/version, not folded into cli), not the cli-internal,
 * zero-export code this design otherwise avoids. `ExecutionRepository` being a
 * plain `@Service()` means it resolves through exactly the same
 * shared-singleton mechanism (`@n8n/di`'s `Container`) that this whole design
 * already depends on for the `WorkflowExecute` patch itself.
 *
 * LAZY-LOADED ON PURPOSE (`await import('@n8n/db')` inside the function below,
 * not a top-level `import` here): a real, reproduced crash. `@n8n/db` pulls in
 * `@n8n/typeorm`, which requires `app-root-path` at ITS OWN module top level;
 * `app-root-path` computes the app root from `require.main` or, failing that,
 * `path.dirname(process.argv[1])` — also at module-load time, unconditionally.
 * A static top-level import here loads that whole chain as part of this
 * package's own `--require` preload, which runs before n8n's own entry script
 * has properly established itself as `require.main` in this exact nested
 * module-loading context — confirmed by reproducing `TypeError
 * [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string. Received
 * undefined` at `app-root-path/lib/resolve.js:117` the moment this was a
 * static import, and confirming it disappears entirely once deferred.
 *
 * Deliberately narrower than the real `workflowExecuteAfter` hook chain: this
 * updates `status`/`finished`/`stoppedAt`/`data` directly, but skips whatever
 * else that chain does (push notifications to a connected editor, telemetry,
 * external-hooks bridging, and the `jsonSizeBytes`/`binaryDataSizeBytes`
 * fields that the cli-internal `ExecutionPersistence` wrapper computes on top
 * of this same repository method). Good enough to fix "the UI shows the wrong
 * status after a crash-recovered execution," not a full hook-chain
 * replacement. run-durably.ts still runs the real hook chain too, best-effort,
 * for that richer behavior when the originating process happens to still be
 * alive.
 *
 * MERGES its own final `resultData.error` onto whatever `resultData`
 * (specifically `runData`) already exists, instead of replacing the whole
 * `data` blob with a fresh, runData-less `createRunExecutionData(...)`
 * object. A real bug, caught only by checking the COMPLETED execution's own
 * record (not just the mid-run one): this activity is the orchestrator's
 * very last step (orchestrator.ts) — dispatched strictly after every
 * `syncNodeProgress` call (execution-progress.ts) a multi-node run made
 * along the way — so a naive fresh-object version would silently erase
 * every node's already-synced incremental progress the moment the
 * orchestration finished, every single time.
 */
export async function buildMergedFinalRunExecutionData(
  executionId: string,
  error: ExecutionError | undefined
): Promise<IRunExecutionData> {
  const {
    ExecutionRepository,
  }: { ExecutionRepository: typeof ExecutionRepositoryType } =
    await import('@n8n/db');
  const executionRepository = Container.get(ExecutionRepository);

  // Same "the placeholder pre-save value parses to undefined" case
  // execution-progress.ts's own doc comment explains — a workflow with NO
  // activity-dispatched nodes at all (e.g. every node was seeded/trigger
  // output) would reach here having never called syncNodeProgress, so there
  // may genuinely be nothing to merge onto yet.
  const current = await executionRepository.findSingleExecution(executionId, {
    includeData: true,
    unflattenData: true,
  });
  const baseData: IRunExecutionData =
    current?.data ?? createRunExecutionData({});
  // `exactOptionalPropertyTypes` (tsconfig.base.json) rejects assigning
  // `error: undefined` to a field typed `error?: ExecutionError` (no
  // explicit `| undefined`) — the key must be either ABSENT or a real
  // `ExecutionError`. Strips any pre-existing `error` from the base first
  // (so a stale error can't survive a later success sync — not currently
  // reachable, since this is only ever called once per orchestration, but
  // correct regardless), then conditionally re-adds it.
  const { error: _priorError, ...restResultData } = baseData.resultData;
  return {
    ...baseData,
    resultData: {
      ...restResultData,
      ...(error !== undefined ? { error } : {}),
    },
  };
}

export async function syncExecutionStatus(
  executionId: string,
  outcome: {
    status: 'success' | 'error';
    finished: boolean;
    error?: ExecutionError | undefined;
    stoppedAt: Date;
  }
): Promise<void> {
  // Confirmed empirically: this package's eager runtime start happens at
  // NODE_OPTIONS --require time, before n8n's own DI bootstrap runs, so
  // there's a real, if narrow, race for the crash-recovered case
  // specifically — a fast Dapr redelivery could in principle reach this call
  // before n8n has finished registering its own services. Retrying with a
  // short backoff rather than assuming immediate readiness; logs which
  // attempt actually succeeded so that race is observable rather than just
  // assumed handled.
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const {
        ExecutionRepository,
      }: { ExecutionRepository: typeof ExecutionRepositoryType } =
        await import('@n8n/db');
      const executionRepository = Container.get(ExecutionRepository);
      const data = await buildMergedFinalRunExecutionData(
        executionId,
        outcome.error
      );
      const updated = await executionRepository.updateExistingExecution(
        executionId,
        {
          status: outcome.status,
          finished: outcome.finished,
          stoppedAt: outcome.stoppedAt,
          data,
        }
      );
      if (!updated) {
        // No conditions were passed above, so the only way updateExistingExecution
        // returns false is if no row matched `executionId` at all — genuinely
        // unexpected (n8n created this row before processRunExecutionData ever
        // ran), worth surfacing rather than silently treating as done.
        console.error(
          `@diagrid/n8n: updateExistingExecution matched no row for execution ${executionId} — ` +
            'the execution record may not exist (or was deleted) despite the orchestration completing.'
        );
      } else {
        console.log(
          `@diagrid/n8n: synced execution ${executionId} status to "${outcome.status}" ` +
            `(attempt ${attempt}/${maxAttempts})`
        );
      }
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        // Best-effort: the orchestration's own success/failure is the real
        // source of truth for the workflow itself. Failing to also correct
        // n8n's own execution record is a visibility problem, not a
        // correctness one — log and move on rather than let it fail the
        // whole activity (which would otherwise retry via Dapr's own
        // activity-retry machinery and repeat this same doomed attempt).
        console.error(
          `@diagrid/n8n: failed to sync execution ${executionId}'s status into n8n's own record after ${maxAttempts} attempts`,
          err
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
}

/** What the orchestrator sends this activity — see orchestrator.ts's final steps. */
export interface SyncExecutionStatusInput {
  executionId: string;
  status: 'success' | 'error';
  /** Only meaningful when status is 'error'. */
  errorMessage?: string;
}

/**
 * Dapr activity wrapper around `syncExecutionStatus`, dispatched by the
 * orchestrator itself as its very last step before returning (see
 * orchestrator.ts) — NOT called from run-durably.ts. That distinction is the
 * actual fix here, found by testing this for real: `runDurably()` only ever
 * runs inside the *original* process's call stack. A SIGKILL destroys that
 * stack along with the process, and — confirmed empirically, by triggering
 * the exact kill-and-resume scenario and observing zero related log output
 * despite `DaprWorkflowClient.getWorkflowState` independently showing the
 * orchestration reached COMPLETED — nothing re-invokes
 * `processRunExecutionData` for that same execution afterward in regular
 * mode. An activity is dispatched by the orchestrator, which — like every
 * other durable step in this design — DOES get replayed/re-driven in
 * whichever process is currently connected, giving this the same "runs in
 * some live process" guarantee every node-execution activity already relies
 * on.
 *
 * `WorkflowOperationError` is built HERE, in the activity, not passed in from
 * the orchestrator or built inline in the orchestrator's own body: its
 * constructor calls `Date.now()`, and orchestrator code must never touch a
 * non-deterministic clock directly — only an activity's result is safe to
 * build from real-time inputs, since it gets cached in history and replayed
 * as a fixed value on every subsequent replay.
 *
 * Input is Zod-validated: this activity's payload comes from the orchestrator
 * and is replayed from Dapr's own history on every subsequent replay —
 * exactly the "crosses the workflow boundary" case this repo's Zod
 * convention targets.
 */
export async function runSyncExecutionStatusActivity(
  _ctx: WorkflowActivityContext,
  rawInput: unknown
): Promise<void> {
  const input = syncExecutionStatusInputSchema.parse(rawInput);
  const isSuccess = input.status === 'success';
  await syncExecutionStatus(input.executionId, {
    status: input.status,
    finished: isSuccess,
    stoppedAt: new Date(),
    error: isSuccess
      ? undefined
      : new WorkflowOperationError(
          input.errorMessage ?? 'orchestration failed'
        ),
  });
}

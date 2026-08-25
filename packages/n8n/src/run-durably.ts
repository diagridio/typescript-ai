// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import { WorkflowRuntimeStatus, workflowStatusName } from '@diagrid/agent-core';
import type { ExecutionLifecycleHooks, WorkflowExecute } from 'n8n-core';
import { createRunExecutionData, WorkflowOperationError } from 'n8n-workflow';
import type {
  IExecuteData,
  IRun,
  IRunExecutionData,
  Workflow,
} from 'n8n-workflow';

import { ORCHESTRATOR_NAME_V2 } from './constants';
import { buildMergedFinalRunExecutionData } from './execution-status-sync';
import { getRuntime } from './runtime';
import { orchestratorResultSchema } from './schemas';
import type { OrchestrationInput, OrchestratorResult } from './types';

// Phase 0 finding, re-verified against this package's now-pinned `@dapr/dapr`
// version (3.18.0): `scheduleNewOrchestration`'s underlying gRPC call
// (`workflow/internal/durabletask/client/client.js`) still has no deadline of
// its own — a bare `promisify(this._stub.startInstance...)` with no
// `deadline`/`options` argument. The original finding (hung 41+ minutes
// under load, no error) was reproduced against a local, unreleased SDK
// checkout; this specific gap was confirmed to still be present in the
// published version by reading the compiled source directly, not by
// re-running the same load test — see README. Never await it unbounded.
const SCHEDULE_TIMEOUT_MS = 15_000;
// Generous ceiling for the proof; a real deployment should poll more
// cleverly than block-and-wait on one call for up to an hour.
const COMPLETION_TIMEOUT_SECONDS = 60 * 60;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `${label} timed out after ${ms}ms (see the "scheduleNewWorkflow can hang forever" finding)`
            )
          ),
        ms
      )
    ),
  ]);
}

/**
 * Replaces WorkflowExecute.prototype.processRunExecutionData. Turns one n8n
 * execution into one Dapr orchestration and waits for it to finish, so callers
 * above this line see the same "await and get a result" contract they always
 * have — durability is meant to be invisible here.
 *
 * TODO(n8n-integration): the real method returns `PCancelable<IRun>`; this
 * returns a plain `Promise`, so anyone calling `.cancel()` on the result
 * (e.g. the editor's "stop execution" button) will not work yet. Wiring that
 * through to `client.terminateWorkflow` is real, separate work.
 */
export async function runDurably(
  instance: WorkflowExecute,
  workflow: Workflow
): Promise<unknown> {
  const startedAt = new Date();
  const { client, started } = await getRuntime();
  await started;

  const executionId = (
    instance as unknown as { additionalData?: { executionId?: string } }
  ).additionalData?.executionId;
  if (!executionId) {
    throw new Error(
      '@diagrid/n8n requires additionalData.executionId to already be set when processRunExecutionData runs'
    );
  }

  // WorkflowExecute.run() (the real, un-patched entry point above
  // processRunExecutionData) already resolved which node(s) to start from and
  // put their input data on `runExecutionData.executionData.nodeExecutionStack`
  // *before* calling processRunExecutionData. For a normal manual run that's
  // just the trigger node, seeded with a single `{ json: {} }` item — which
  // also happens to be exactly what the trigger's own execute-equivalent
  // (`trigger()` + `emit()`, a protocol this package doesn't implement — see
  // OrchestrationInput.seed's doc) would have produced as output.
  // `runExecutionData` is a private field on WorkflowExecute; reached the
  // same way `additionalData` already is above, since patching a private
  // method necessarily means working with the caller's already-private state.
  const initialStack =
    (
      instance as unknown as {
        runExecutionData?: {
          executionData?: { nodeExecutionStack?: IExecuteData[] };
        };
      }
    ).runExecutionData?.executionData?.nodeExecutionStack ?? [];

  const input: OrchestrationInput = {
    nodes: Object.values(workflow.nodes),
    connections: workflow.connectionsBySourceNode,
    seed: initialStack.map((executeData) => ({
      nodeName: executeData.node.name,
      outputItems: (executeData.data['main'] ?? []).map((items) => items ?? []),
    })),
  };

  // The execution id doubles as the Dapr instance id, which makes "start" the
  // same call as "resume": if an orchestration under this id already exists and
  // is running — e.g. a queue-mode worker picking the job back up after a crash
  // — this should attach to it rather than error on a duplicate id.
  //
  // Schedules against ORCHESTRATOR_NAME_V2, not the original
  // ORCHESTRATOR_NAME — v2 is "current" for every NEW top-level execution. v1
  // stays registered (runtime.ts) purely to keep draining whatever instances
  // already committed to it in their own history before this line changed —
  // see README's "Versioning discipline" section for the real
  // kill-and-resume-across-versions proof this is built to support.
  await withTimeout(
    client.scheduleNewWorkflow(ORCHESTRATOR_NAME_V2, input, executionId),
    SCHEDULE_TIMEOUT_MS,
    'scheduleNewWorkflow'
  );

  const state = await client.waitForWorkflowCompletion(
    executionId,
    true,
    COMPLETION_TIMEOUT_SECONDS
  );

  // `WorkflowRuntimeStatus` is reused from `@diagrid/agent-core` (not
  // re-declared here, and not the raw `@dapr/dapr` enum) — this removes a
  // whole class of risk this package once had for real: comparing
  // `state?.runtimeStatus === 'COMPLETED'` (a string) against the SDK's
  // actual numeric enum is silently always false. `workflowStatusName` gives
  // a readable name for logging without hand-rolling the reverse lookup.
  //
  // The `Number(...)` on the left is deliberate, not decorative: `state`'s
  // `runtimeStatus` is typed via `@dapr/dapr`'s own real TS `enum`, while
  // `WorkflowRuntimeStatus` here is core's const-object-plus-derived-type
  // reuse of the SAME numbers (see status.ts's own doc comment on why it's
  // declared, not re-exported) — two nominally different enum-like types the
  // linter can't know share a wire format, even though
  // `tests/core/workflow/status.test.ts` asserts they do. Normalizing to a
  // plain number resolves the comparison honestly instead of silencing the
  // lint rule that exists to catch exactly this class of mismatch.
  const isDurableTaskCompleted =
    Number(state?.runtimeStatus) === WorkflowRuntimeStatus.COMPLETED;

  // A business-logic failure inside the workflow (a node exhausting its
  // retries) is a normal *return* from the orchestrator, not a thrown
  // exception (deliberately — this avoids also triggering Dapr's own
  // orchestration-level retry on top of ours). That means Dapr's own
  // runtimeStatus is COMPLETED either way; the actual outcome only exists in
  // the orchestrator's returned payload, round-tripped through
  // `serializedOutput`. Only a genuine Dapr/orchestrator-level fault (a thrown
  // exception, e.g. a bug in orchestrator.ts itself) produces a real FAILED
  // runtimeStatus — see README for the real, run-and-observed
  // `OrchestratorNotRegisteredError` case this project has separately proven
  // does exactly that.
  //
  // Reuses the same OrchestratorResult a *parent* orchestration reads
  // directly off `callChildWorkflow` for a sub-workflow node — a top-level
  // execution's `serializedOutput` is just this type's JSON round-trip, since
  // a top-level and a child orchestration are the same function. Zod-parsed,
  // not trusted as a bare cast — this value crossed the same replay/history
  // boundary orchestrator.ts's own activity results do.
  let orchestrationOutput: OrchestratorResult | undefined;
  if (isDurableTaskCompleted && state?.serializedOutput) {
    try {
      orchestrationOutput = orchestratorResultSchema.parse(
        JSON.parse(state.serializedOutput)
      ) as OrchestratorResult;
    } catch {
      // Leave undefined — treated as failure below, same as a missing output.
    }
  }

  const isSuccess =
    isDurableTaskCompleted && orchestrationOutput?.status === 'success';
  // `OrchestratorResult` is a real discriminated union — narrow by `.status`
  // explicitly rather than optional-chaining straight to `.message`, which
  // only exists on the 'error' variant.
  let errorMessage: string | undefined;
  if (!isDurableTaskCompleted) {
    errorMessage = `orchestration did not complete (runtimeStatus: ${
      state ? workflowStatusName(state.runtimeStatus) : 'unknown (no state)'
    })`;
  } else if (orchestrationOutput?.status === 'error') {
    errorMessage = orchestrationOutput.message;
  } else if (orchestrationOutput?.status !== 'success') {
    errorMessage = 'orchestration did not report success';
  }

  // `createRunExecutionData` is n8n-workflow's own factory for `IRunExecutionData`
  // — that type is deliberately branded ("Use createRunExecutionData factory
  // instead of constructing manually", run-execution-data.ts) specifically to
  // stop a plain object literal from satisfying it. Confirmed against
  // `determineFinalExecutionStatus` / `prepareExecutionDataForDbUpdate`
  // (packages/cli/src/execution-lifecycle/shared/shared-hook-functions.ts,
  // the real DB-persistence path this hook call feeds) that `resultData.error`
  // presence/absence is what actually drives the persisted status.
  //
  // `storedAt` is hardcoded to 'db' rather than read off the instance: it's
  // also n8n's own default (WorkflowExecute's constructor takes it as an
  // optional 4th param defaulting to 'db') and this package doesn't support
  // the alternative binary-data-style storage backends regardless.
  //
  // ExecutionError is a union of n8n's own real error classes, not a generic
  // {message, name} shape — confirmed by tsc rejecting the latter.
  // WorkflowOperationError is the "something failed at the operation level,
  // not a specific node" case, which is exactly what an orchestrator-reported
  // failure is from n8n's perspective.
  const finalError = isSuccess
    ? undefined
    : new WorkflowOperationError(errorMessage ?? 'orchestration failed');

  // A real bug, found only by checking a COMPLETED execution's own record,
  // not just the mid-run one — see execution-status-sync.ts's own doc
  // comment for the full story. This hook call (below) triggers a REAL n8n
  // `workflowExecuteAfter` handler that saves `run.data` as-is. A plain
  // `createRunExecutionData({resultData: {error}})` here has no `runData` at
  // all, and — since this hook fires for every NON-crashed execution, the
  // common case, strictly AFTER the orchestrator's own
  // SYNC_EXECUTION_STATUS_ACTIVITY_NAME step has already correctly merged and
  // written real per-node progress — would silently erase that already-correct
  // data the moment this best-effort hook happens to fire, every single time.
  // `buildMergedFinalRunExecutionData` (shared with that same activity) merges
  // onto the existing record instead. Falls back to the old runData-less
  // object only if the merge fetch itself fails, so this best-effort hook
  // call can never throw/hang runDurably() over it.
  let data: IRunExecutionData;
  try {
    data = await buildMergedFinalRunExecutionData(executionId, finalError);
  } catch (err) {
    console.error(
      '@diagrid/n8n: failed to merge final run data onto existing execution progress; ' +
        'falling back to a fresh (runData-less) object',
      err
    );
    // `exactOptionalPropertyTypes` rejects `error: undefined` against a field
    // typed `error?: ExecutionError` (no explicit `| undefined`) — same
    // pattern as execution-status-sync.ts's own fix.
    data = createRunExecutionData(
      finalError !== undefined ? { resultData: { error: finalError } } : {}
    );
  }

  const stoppedAt = new Date();
  const run: IRun = {
    finished: isSuccess,
    mode: 'manual',
    startedAt,
    stoppedAt,
    storedAt: 'db',
    status: isSuccess ? 'success' : 'error',
    data,
  };

  // Real processRunExecutionData runs this same hook (workflow-execute.ts) as
  // its own last step — it's what actually persists `finished`/`status` to
  // n8n's execution record (packages/cli's hookFunctionsSave) and pushes the
  // "execution finished" event to the editor (hookFunctionsPush).
  // `additionalData.hooks` is already built and attached by n8n's own cli
  // code before processRunExecutionData ever runs, so this is invoking
  // existing plumbing, not building new plumbing.
  //
  // PURELY BEST-EFFORT, on purpose, not a fallback with a safety net below:
  // this only works when the originating WorkflowExecute instance (and its
  // closed-over `additionalData.hooks`) is still alive, which after a crash
  // it never is. The actual, working fix is `orchestrator.ts` dispatching
  // `SYNC_EXECUTION_STATUS_ACTIVITY_NAME` as its own last step before
  // returning (see execution-status-sync.ts) — an activity, unlike this
  // function, is guaranteed to run in *some* live process regardless of what
  // happened to the one that originally scheduled it. What's left here is
  // genuinely optional: the push-to-editor/telemetry/external-hooks behavior
  // the real hook chain gives on top of the status write, when the
  // originating process happens to still be around to provide it.
  try {
    const hooks = (
      instance as unknown as {
        additionalData?: { hooks?: ExecutionLifecycleHooks };
      }
    ).additionalData?.hooks;
    if (hooks) {
      await hooks.runHook('workflowExecuteAfter', [run, {}]);
    }
  } catch (err) {
    console.error('@diagrid/n8n: workflowExecuteAfter hook failed', err);
  }

  return run;
}

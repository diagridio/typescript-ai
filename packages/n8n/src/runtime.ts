// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * This module cannot subclass `@diagrid/agent-core`'s `BaseWorkflowRunner`:
 * its constructor requires a `SupportedFramework` value, a closed union n8n
 * is deliberately not a member of (see README's "Why not `SupportedFrameworks`"
 * section — n8n workflows are not AI agents in the sense that type models).
 * Widening core's own type to fit, or casting past it, are both against this
 * project's own standards (and core's own isolation guarantees). So this
 * module borrows `BaseWorkflowRunner`'s (packages/core/src/workflow/runner.ts)
 * *patterns* directly, rather than inheriting them:
 *
 *  - Idempotent, lazily-constructed runtime (`getRuntime()` below) — a
 *    dynamic `await import('@dapr/dapr')`, not a static top-level import, for
 *    the same reason `dapr.ts`/`status.ts` in core avoid one: a static import
 *    made a bare `require('@diagrid/agent-mastra')` eagerly load ~136
 *    `@dapr/dapr` modules and ~65 from `@grpc/grpc-js` before any adapter
 *    code ran. This package is `--require`d into every n8n boot (see
 *    preload.ts), so the same cost applies here, arguably more directly.
 *  - `shutdown()` attempts every cleanup step independently and collects
 *    failures into an `AggregateError`, rather than letting one throw strand
 *    the rest — the exact bug `runner.ts`'s own doc comment describes fixing:
 *    an early throw skipped the remaining steps, and every later call
 *    returned early because status had already flipped to "stopped".
 *  - Telemetry setup/shutdown via core's own `setupTelemetry`.
 *
 * The real, plainly-stated consequence of not going through
 * `BaseWorkflowRunner`: this package needs `@dapr/dapr` as its own direct
 * dependency (see package.json) — the *only* file in this package that
 * actually imports it as a runtime value is this one. Every other file
 * (orchestrator.ts, activity.ts, execution-status-sync.ts, sub-workflow.ts,
 * round-log.ts) only needs `WorkflowContext`/`WorkflowActivityContext` as
 * TYPES, which `@diagrid/agent-core` already re-exports type-only — those
 * files import the type from core, not from `@dapr/dapr` directly, keeping
 * the divergence as narrow as it can be while still being real.
 */

import {
  setupTelemetry,
  type ObservabilityConfig,
  type TelemetryHandle,
  type DaprWorkflowClient,
  type WorkflowRuntime,
} from '@diagrid/agent-core';
import { isMainThread, threadId } from 'node:worker_threads';
import * as fs from 'node:fs';

import { runN8nNodeActivity } from './activity';
import {
  ACTIVITY_NAME,
  LOG_ROUND_START_ACTIVITY_NAME,
  ORCHESTRATOR_NAME,
  ORCHESTRATOR_NAME_V2,
  RESOLVE_SUB_WORKFLOW_ACTIVITY_NAME,
  SYNC_EXECUTION_STATUS_ACTIVITY_NAME,
} from './constants';
import { runSyncExecutionStatusActivity } from './execution-status-sync';
import { closeLedgerStore } from './ledger';
import { runN8nNodeOrchestrator } from './orchestrator';
import { runN8nNodeOrchestratorV2 } from './orchestrator-v2';
import { runLogRoundStartActivity } from './round-log';
import { resolveSubWorkflowActivity } from './sub-workflow';

interface RuntimeSingleton {
  runtime: WorkflowRuntime;
  client: DaprWorkflowClient;
  started: Promise<void>;
}

/** Mirrors `BaseWorkflowRunner`'s own `RunnerStatus` — see runner.ts. */
type RunnerStatus = 'created' | 'started' | 'stopping' | 'stopped';
let status: RunnerStatus = 'created';

// Module-level singleton, holding the in-flight *construction* promise (not
// just a resolved value) so two concurrent callers before the first
// resolution can't each build a competing runtime. NOTE (verified
// empirically in earlier phases of this package's development — see README):
// n8n's worker_threads share an OS PID with their parent but get their own
// isolated module registry, so this guard only protects re-evaluation
// *within one such registry*.
let runtimePromise: Promise<RuntimeSingleton> | undefined;
let telemetry: TelemetryHandle | undefined;

/**
 * Test-only knob: when set, skips registering v1's orchestrator function —
 * simulating a (wrong) deploy that dropped v1 before every v1-bound
 * in-flight instance had drained. Never set in normal operation; exists
 * purely to observe, for real, what actually happens when an in-flight
 * instance's history names an orchestrator the CURRENT process genuinely
 * doesn't have registered — see README's "Versioning discipline" section for
 * the real observed behavior this was used to produce
 * (`OrchestratorNotRegisteredError`, caught by the `@dapr/dapr` worker and
 * turned into a clean, terminal FAILED status for that one instance — not a
 * hang, not a crash).
 */
const SKIP_ORCHESTRATOR_V1 =
  process.env['DIAGRID_N8N_SKIP_ORCHESTRATOR_V1'] === 'true';

/**
 * Diagnostic-only: sink for the worker_thread singleton check inherited from
 * earlier phases of this package. Opt-in via env var, set to a file path to
 * record one line per *new* runtime construction, across however many
 * isolated module registries (main thread + any worker_threads) end up
 * loading this module in one process lifetime.
 */
function logRuntimeCreation(): void {
  const sink = process.env['DIAGRID_N8N_RUNTIME_DEBUG_LOG'];
  if (!sink) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event: 'new-workflow-runtime',
    pid: process.pid,
    isMainThread,
    threadId,
  });
  try {
    fs.appendFileSync(sink, line + '\n');
  } catch {
    // Diagnostic-only — never let logging failures affect real behavior.
  }
}

async function buildRuntime(): Promise<RuntimeSingleton> {
  logRuntimeCreation();

  telemetry = await setupTelemetry(
    'diagrid.n8n',
    undefined as ObservabilityConfig | undefined
  );

  // Dynamic import, not a static top-level one — see this file's own
  // top-of-file doc comment for why.
  const { WorkflowRuntime: Runtime, DaprWorkflowClient: Client } =
    await import('@dapr/dapr');

  const runtime: WorkflowRuntime = new Runtime();
  const client: DaprWorkflowClient = new Client();

  if (!SKIP_ORCHESTRATOR_V1) {
    runtime.registerWorkflowWithName(ORCHESTRATOR_NAME, runN8nNodeOrchestrator);
  }
  runtime.registerWorkflowWithName(
    ORCHESTRATOR_NAME_V2,
    runN8nNodeOrchestratorV2
  );
  runtime.registerActivityWithName(ACTIVITY_NAME, runN8nNodeActivity);
  runtime.registerActivityWithName(
    SYNC_EXECUTION_STATUS_ACTIVITY_NAME,
    runSyncExecutionStatusActivity
  );
  runtime.registerActivityWithName(
    RESOLVE_SUB_WORKFLOW_ACTIVITY_NAME,
    resolveSubWorkflowActivity
  );
  runtime.registerActivityWithName(
    LOG_ROUND_START_ACTIVITY_NAME,
    runLogRoundStartActivity
  );

  const started = runtime.start();
  status = 'started';
  return { runtime, client, started };
}

/**
 * Idempotent: concurrent/repeated calls all resolve to the same runtime —
 * mirrors `BaseWorkflowRunner.start()`'s own idempotency, achieved here by
 * memoizing the construction *promise* rather than checking a status flag
 * before starting a second one.
 *
 * Same caveat `BaseWorkflowRunner.start()` documents: `WorkflowRuntime.start()`
 * does not await its connection — the SDK sets its own running flag and
 * retries in the background — so this resolving does not mean the sidecar is
 * reachable, only that the runtime was constructed and registered.
 */
export function getRuntime(): Promise<RuntimeSingleton> {
  runtimePromise ??= buildRuntime();
  return runtimePromise;
}

/**
 * Stop the workflow runtime and release every resource this module owns.
 *
 * Every step runs even if an earlier one throws — the exact fix
 * `BaseWorkflowRunner.shutdown()`'s own doc comment describes needing: a
 * `stop()` thrown against an unreachable sidecar must not skip the remaining
 * cleanup steps, and the status must only become `stopped` once cleanup has
 * actually been attempted, with any failures reported to the caller rather
 * than swallowed.
 */
export async function shutdownRuntime(): Promise<void> {
  if (status !== 'started' || !runtimePromise) {
    return;
  }
  // Guards re-entry before the first await, so a second call — or a second
  // signal — cannot run cleanup concurrently with the first.
  status = 'stopping';

  const { runtime, client } = await runtimePromise;

  const failures: unknown[] = [];
  const attempt = async (
    what: string,
    fn: () => Promise<unknown> | undefined
  ) => {
    try {
      await fn();
    } catch (cause) {
      failures.push(
        new Error(`failed to ${what} while shutting down`, { cause })
      );
    }
  };

  await attempt('stop the workflow runtime', () => runtime.stop());
  await attempt('stop the workflow client', () => client.stop());
  await attempt('close the ledger state store', () => closeLedgerStore());
  await attempt('shut down telemetry', () => telemetry?.shutdown());

  runtimePromise = undefined;
  telemetry = undefined;
  status = 'stopped';

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `@diagrid/n8n: ${failures.length} of 4 shutdown steps failed`
    );
  }
}

/**
 * Shut down cleanly on SIGINT/SIGTERM. Opt-in, not automatic — a library
 * (and this package's own preload hook is exactly that, even though it
 * activates itself via `--require` rather than an explicit constructor call)
 * must not install process-wide signal handlers behind the host process's
 * back without being asked. `preload.ts` calls this.
 */
export function registerShutdownHandlers(): () => void {
  const handler = () => {
    // The rejection is caught rather than discarded — an unhandled rejection
    // crashes Node >= 15, which would turn a graceful SIGTERM into exactly
    // the crash it was trying to avoid.
    void shutdownRuntime().catch((cause: unknown) => {
      process.emitWarning(
        `@diagrid/n8n: shutdown did not complete cleanly: ${String(cause)}`,
        {
          code: 'DIAGRID_N8N_SHUTDOWN_INCOMPLETE',
        }
      );
    });
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

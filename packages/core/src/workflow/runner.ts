// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Base workflow runner — shared lifecycle for every framework adapter.
 *
 * Port of `diagrid/agent/core/workflow/runner.py` in `diagridio/python-ai`.
 * This class owns everything that is identical across frameworks: the Dapr
 * workflow runtime lifecycle, the canonical workflow name, status/terminate/
 * purge passthroughs, telemetry setup and graceful shutdown. A framework
 * adapter subclasses it and implements the two abstract members:
 * `registerWorkflowComponents` and `get mapper()`. `setupTelemetry` is
 * concrete — overriding it is optional and the one existing adapter does not.
 */

import type {
  DaprWorkflowClient,
  WorkflowRuntime,
  WorkflowState,
} from '@dapr/dapr';
import type { WorkflowClientOptions } from '@dapr/dapr/types/workflow/WorkflowClientOption';

import type { AgentMapper } from '../mapping/base';
import { DaprStateStore } from '../state/store';
import {
  setupTelemetry,
  type ObservabilityConfig,
  type TelemetryHandle,
} from '../telemetry/telemetry';
import type { SupportedFramework } from '../types/frameworks';
import { buildWorkflowName } from './naming';

/** Options common to every framework runner. */
export interface BaseWorkflowRunnerOptions {
  /** Agent name. Required — it is half of the canonical workflow name. */
  readonly name: string;
  /** Dapr sidecar host. Defaults to the `@dapr/dapr` default (`127.0.0.1`). */
  readonly host?: string;
  /** Dapr sidecar gRPC port. Defaults to the `@dapr/dapr` default (`50001`). */
  readonly port?: string;
  /** Hard cap on agent loop iterations per workflow. */
  readonly maxIterations?: number;
  /** State store used for checkpoints and registry metadata. */
  readonly stateStore?: DaprStateStore;
  /** Explicit observability config. Falls back to `OTEL_*` env vars. */
  readonly observability?: ObservabilityConfig;
}

/** Lifecycle phase of a runner, exposed for tests and health endpoints. */
/**
 * `stopping` exists so shutdown can guard re-entry before its first await
 * without claiming to be finished. Without it, a shutdown that failed part-way
 * still read `stopped`, and the next call returned early instead of retrying —
 * so resources this runner owned were never released.
 */
export type RunnerStatus = 'created' | 'started' | 'stopping' | 'stopped';

export abstract class BaseWorkflowRunner {
  readonly name: string;
  readonly framework: SupportedFramework;
  readonly maxIterations: number;

  protected readonly host: string | undefined;
  protected readonly port: string | undefined;
  protected readonly stateStore: DaprStateStore;
  protected readonly observability: ObservabilityConfig | undefined;

  protected workflowRuntime: WorkflowRuntime | undefined;
  protected workflowClient: DaprWorkflowClient | undefined;
  protected telemetry: TelemetryHandle | undefined;

  #status: RunnerStatus = 'created';

  protected constructor(
    framework: SupportedFramework,
    options: BaseWorkflowRunnerOptions
  ) {
    if (!options.name) {
      throw new Error('BaseWorkflowRunner requires a non-empty agent name');
    }
    this.framework = framework;
    this.name = options.name;
    this.host = options.host;
    this.port = options.port;
    this.maxIterations = options.maxIterations ?? 25;
    this.stateStore = options.stateStore ?? new DaprStateStore();
    this.observability = options.observability;
  }

  /**
   * The canonical Dapr workflow name: `dapr.<framework>.<AgentName>.workflow`.
   *
   * Computed once from the framework and agent name so the value used to
   * register the workflow is always the value published in registry metadata.
   */
  get workflowName(): string {
    return buildWorkflowName(this.framework, this.name);
  }

  get status(): RunnerStatus {
    return this.#status;
  }

  get isRunning(): boolean {
    return this.#status === 'started';
  }

  /**
   * Start the Dapr workflow runtime.
   *
   * Idempotent: calling `start()` on an already-started runner is a no-op, so
   * a framework that eagerly starts on first invoke stays safe.
   *
   * # `started` does not mean the sidecar is reachable
   *
   * `WorkflowRuntime.start()` deliberately does not await its connection: the
   * SDK sets its own running flag, returns, and retries in the background. So
   * this resolves — and {@link status} reads `started` — even when nothing is
   * listening on the configured host and port. There is no callback or promise
   * to observe that failure through.
   *
   * Treat `started` as "the runtime was constructed and registered", not as a
   * reachability check. A real readiness probe needs the sidecar's health
   * endpoint, which is on the HTTP port this runner does not take.
   */
  async start(): Promise<void> {
    if (this.#status === 'started') {
      return;
    }

    this.telemetry = await this.setupTelemetry();

    const { WorkflowRuntime: Runtime, DaprWorkflowClient: Client } =
      await import('@dapr/dapr');

    // Built key-by-key rather than with `??`-defaults so an unset host/port
    // falls through to the `@dapr/dapr` defaults instead of being pinned here
    // — the SDK's defaults are the ones the Dapr CLI and Catalyst agree on.
    const settings: Partial<WorkflowClientOptions> = {};
    if (this.host !== undefined) {
      settings.daprHost = this.host;
    }
    if (this.port !== undefined) {
      settings.daprPort = this.port;
    }

    this.workflowRuntime = new Runtime(settings);
    this.workflowClient = new Client(settings);

    this.registerWorkflowComponents(this.workflowRuntime);

    await this.workflowRuntime.start();
    this.#status = 'started';
  }

  /**
   * Stop the workflow runtime and release every resource this runner owns.
   *
   * Safe to call from a SIGINT/SIGTERM handler and safe to call twice, which
   * is what {@link registerShutdownHandlers} relies on.
   *
   * # Every step runs even if an earlier one throws
   *
   * This used to `await` the four cleanup calls in sequence after setting the
   * status to `stopped`. Two things went wrong together, and a not-ready
   * sidecar triggered both.
   *
   * `WorkflowRuntime.start()` does not await its connection — the SDK sets its
   * own running flag, returns, and fails in the background — so against an
   * unreachable sidecar this runner reads `started` while the SDK's worker is
   * not running. `stop()` then throws its own `The worker is not running.`
   * guard. Because the status had *already* been flipped to `stopped`, the
   * throw skipped `workflowClient.stop()`, `stateStore.close()` and
   * `telemetry.shutdown()`, and every later `shutdown()` returned early — so
   * the connections this runner owned were never released and nothing said so.
   *
   * Each step is now attempted independently and failures are collected, so one
   * broken handle cannot strand the others. The status only becomes `stopped`
   * once cleanup has actually been attempted, and any failures are reported to
   * the caller rather than swallowed.
   */
  async shutdown(): Promise<void> {
    if (this.#status !== 'started') {
      return;
    }
    // Guards re-entry before the first await, so a second call — or a second
    // signal — cannot run cleanup concurrently with the first.
    this.#status = 'stopping';

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

    await attempt('stop the workflow runtime', () =>
      this.workflowRuntime?.stop()
    );
    await attempt('stop the workflow client', () =>
      this.workflowClient?.stop()
    );
    await attempt('close the state store', () => this.stateStore.close());
    await attempt('shut down telemetry', () => this.telemetry?.shutdown());

    this.workflowRuntime = undefined;
    this.workflowClient = undefined;
    this.telemetry = undefined;
    this.#status = 'stopped';

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${this.name}: ${failures.length} of 4 shutdown steps failed`
      );
    }
  }

  /**
   * Shut down cleanly on SIGINT/SIGTERM.
   *
   * The Python runners get this from dapr-agents' `SignalMixin`; on Node it is
   * an explicit opt-in because a library must not install process-wide signal
   * handlers behind the caller's back. Returns a disposer that removes the
   * handlers again.
   */
  registerShutdownHandlers(): () => void {
    const handler = () => {
      // The rejection is caught rather than discarded. `void promise` leaves an
      // unhandled rejection, and Node >= 15 terminates the process on one — so
      // a runner whose sidecar was already unreachable turned a graceful
      // SIGTERM into a crash, at exactly the moment the operator was trying to
      // shut down cleanly. A library that installs process-wide signal handlers
      // must not be able to do that.
      void this.shutdown().catch((cause: unknown) => {
        process.emitWarning(
          `${this.name}: shutdown did not complete cleanly: ${String(cause)}`,
          { code: 'DIAGRID_SHUTDOWN_INCOMPLETE' }
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

  /**
   * Fetch the current state of a workflow instance.
   *
   * `fetchPayloads` defaults to `true` because the caller of a status check is
   * almost always after the output; pass `false` on hot polling paths where
   * only the runtime status matters.
   */
  async getWorkflowStatus(
    workflowId: string,
    fetchPayloads = true
  ): Promise<WorkflowState | undefined> {
    const client = this.requireClient();
    return (
      (await client.getWorkflowState(workflowId, fetchPayloads)) ?? undefined
    );
  }

  /** Terminate a running workflow instance, optionally setting its output. */
  async terminateWorkflow(workflowId: string, output?: unknown): Promise<void> {
    await this.requireClient().terminateWorkflow(workflowId, output ?? null);
  }

  /**
   * Purge a completed workflow instance's history.
   *
   * Returns `false` when there was no such instance to purge, which callers
   * doing cleanup can safely ignore.
   */
  async purgeWorkflow(workflowId: string): Promise<boolean> {
    return this.requireClient().purgeWorkflow(workflowId);
  }

  protected requireClient(): DaprWorkflowClient {
    if (!this.workflowClient) {
      throw new Error(
        `Runner "${this.name}" is not started — call start() before using the workflow client`
      );
    }
    return this.workflowClient;
  }

  /**
   * Wire up tracing. No-ops unless an OTLP endpoint is configured.
   *
   * Adapters override this when the framework ships its own instrumentation
   * that has to be attached to the same provider.
   */
  protected async setupTelemetry(): Promise<TelemetryHandle | undefined> {
    return setupTelemetry(this.workflowName, this.observability);
  }

  /**
   * Register the workflow and its activities on the runtime.
   *
   * Called once, from `start()`, before the runtime is started — Dapr requires
   * every workflow and activity to be registered up front.
   */
  protected abstract registerWorkflowComponents(runtime: WorkflowRuntime): void;

  /** The mapper that turns this framework's agent into registry metadata. */
  abstract get mapper(): AgentMapper;
}

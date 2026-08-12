// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Base workflow runner — shared lifecycle for every framework adapter.
 *
 * Port of `diagrid/agent/core/workflow/runner.py` in `diagridio/python-ai`.
 * This class owns everything that is identical across frameworks: the Dapr
 * workflow runtime lifecycle, the canonical workflow name, status/terminate/
 * purge passthroughs, telemetry setup and graceful shutdown. A framework
 * adapter subclasses it and implements the three abstract hooks.
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
export type RunnerStatus = 'created' | 'started' | 'stopped';

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
   */
  async shutdown(): Promise<void> {
    if (this.#status !== 'started') {
      return;
    }
    this.#status = 'stopped';

    await this.workflowRuntime?.stop();
    await this.workflowClient?.stop();
    await this.stateStore.close();
    await this.telemetry?.shutdown();

    this.workflowRuntime = undefined;
    this.workflowClient = undefined;
    this.telemetry = undefined;
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
      void this.shutdown();
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

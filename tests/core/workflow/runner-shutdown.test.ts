// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Shutdown must release everything it owns, and must never crash the process.
 *
 * These exist because of a defect found in review and reproduced against a
 * closed port. `WorkflowRuntime.start()` deliberately does not await its
 * connection — the SDK sets its own running flag, returns, and fails in the
 * background — so this runner reads `started` against an unreachable sidecar.
 * `stop()` then throws the SDK's own `The worker is not running.` guard. Because
 * the status had already been flipped to `stopped` before the awaits, that throw
 * skipped `workflowClient.stop()`, `stateStore.close()` and
 * `telemetry.shutdown()`, and every later `shutdown()` returned early — so the
 * connections this runner owned were never released and nothing said so.
 *
 * Worse, `registerShutdownHandlers()` discarded the rejection with `void`, and
 * Node >= 15 terminates the process on an unhandled rejection. A graceful
 * SIGTERM therefore became a crash, at exactly the moment an operator was
 * trying to shut down cleanly with a sidecar already down.
 *
 * The SDK is mocked rather than stubbed past, so `start()` and `shutdown()` run
 * for real — the ordering bug lived in that exact sequence, and a test that set
 * the private status directly would not have caught it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMapper } from '../../../packages/core/src/mapping/base.js';

const ran: string[] = [];
let runtimeStopThrows = false;

vi.mock('@dapr/dapr', () => ({
  WorkflowRuntime: class {
    start(): Promise<void> {
      // Mirrors the real SDK: resolves without awaiting the connection.
      return Promise.resolve();
    }
    stop(): Promise<void> {
      ran.push('workflowRuntime.stop');
      if (runtimeStopThrows) {
        // The SDK's own message, verbatim.
        return Promise.reject(new Error('The worker is not running.'));
      }
      return Promise.resolve();
    }
  },
  DaprWorkflowClient: class {
    stop(): Promise<void> {
      ran.push('workflowClient.stop');
      return Promise.resolve();
    }
  },
}));

const { BaseWorkflowRunner } =
  await import('../../../packages/core/src/workflow/runner.js');
const { DaprStateStore } =
  await import('../../../packages/core/src/state/store.js');

/** A runner whose state store records its close, and nothing else. */
class TestRunner extends BaseWorkflowRunner {
  constructor() {
    const store = new DaprStateStore();
    store.close = (): Promise<void> => {
      ran.push('stateStore.close');
      return Promise.resolve();
    };
    super('Mastra', { name: 'test-runner', stateStore: store });
  }

  protected registerWorkflowComponents(): void {
    // Lifecycle, not dispatch.
  }

  // Abstract on the base; never reached by these tests, which stop at start
  // and shutdown. Throwing rather than returning a stub keeps it honest: if a
  // future test does reach it, it fails loudly instead of asserting on a fake.
  get mapper(): AgentMapper {
    throw new Error('mapper is not exercised by the lifecycle tests');
  }
}

async function startedRunner(): Promise<TestRunner> {
  const runner = new TestRunner();
  await runner.start();
  expect(runner.status).toBe('started');
  return runner;
}

beforeEach(() => {
  ran.length = 0;
  runtimeStopThrows = false;
});

describe('shutdown', () => {
  it('runs every cleanup step even when the runtime stop throws', async () => {
    // The reproduced defect: a not-ready sidecar makes the FIRST step throw,
    // and the steps after it are the ones that actually release connections.
    runtimeStopThrows = true;
    const runner = await startedRunner();

    await expect(runner.shutdown()).rejects.toThrow(/shutdown steps failed/);

    expect(ran).toEqual([
      'workflowRuntime.stop',
      'workflowClient.stop',
      'stateStore.close',
    ]);
  });

  it('reports the underlying cause rather than swallowing it', async () => {
    runtimeStopThrows = true;
    const runner = await startedRunner();

    const err: unknown = await runner.shutdown().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AggregateError);
    const causes = (err as AggregateError).errors.map((e) =>
      String((e as Error).cause)
    );
    expect(causes.some((c) => c.includes('The worker is not running'))).toBe(
      true
    );
  });

  it('reaches stopped even when a step failed, so a retry is not silently skipped', async () => {
    runtimeStopThrows = true;
    const runner = await startedRunner();

    await runner.shutdown().catch(() => undefined);

    expect(runner.status).toBe('stopped');
  });

  it('runs every step and succeeds on the happy path', async () => {
    const runner = await startedRunner();

    await expect(runner.shutdown()).resolves.toBeUndefined();

    expect(ran).toEqual([
      'workflowRuntime.stop',
      'workflowClient.stop',
      'stateStore.close',
    ]);
    expect(runner.status).toBe('stopped');
  });

  it('is a no-op when never started', async () => {
    const runner = new TestRunner();

    await expect(runner.shutdown()).resolves.toBeUndefined();

    expect(ran).toEqual([]);
  });
});

describe('registerShutdownHandlers', () => {
  it('does not leave an unhandled rejection when shutdown fails', async () => {
    // This is the crash. `void promise` with no catch is an unhandled
    // rejection, and Node >= 15 terminates the process on one — so the failure
    // mode was "the runner kills your service during SIGTERM".
    runtimeStopThrows = true;
    const runner = await startedRunner();

    const unhandled = vi.fn();
    const warnings: string[] = [];
    const onWarning = (w: Error): void => {
      warnings.push(w.message);
    };
    process.on('unhandledRejection', unhandled);
    process.on('warning', onWarning);

    const dispose = runner.registerShutdownHandlers();
    process.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 50));

    dispose();
    process.off('unhandledRejection', unhandled);
    process.off('warning', onWarning);

    expect(unhandled).not.toHaveBeenCalled();
    expect(warnings.some((w) => w.includes('did not complete cleanly'))).toBe(
      true
    );
  });

  it('removes its handlers when disposed', async () => {
    const runner = await startedRunner();
    const before = {
      term: process.listenerCount('SIGTERM'),
      // SIGINT as well as SIGTERM. Only SIGTERM was asserted, so deleting the
      // `process.once('SIGINT', handler)` registration survived the whole gate
      // — and the regression it hides is Ctrl-C silently ceasing to be graceful,
      // in the file whose entire purpose is graceful shutdown. The disposer
      // still calls `process.off('SIGINT', ...)`, so nothing goes unused and
      // lint cannot see it either.
      int: process.listenerCount('SIGINT'),
    };

    const dispose = runner.registerShutdownHandlers();
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);

    dispose();
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
    expect(process.listenerCount('SIGINT')).toBe(before.int);
  });
});

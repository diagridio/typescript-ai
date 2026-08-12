// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Runner behaviour that does not need a Dapr sidecar.
 *
 * `start()` is deliberately not exercised here — it constructs a real
 * `WorkflowRuntime` and opens a gRPC channel, which belongs in the integration
 * lane. What is covered is everything a caller can get wrong *before* a
 * sidecar is involved: naming, metadata, and the pre-start error messages.
 */

import { describe, expect, it } from 'vitest';

import { DaprWorkflowAgentRunner } from '@diagrid/agent-mastra';

import { fakeMastraAgent } from '../fixtures/mastra-agent';

const newRunner = (
  overrides: Partial<
    ConstructorParameters<typeof DaprWorkflowAgentRunner>[0]
  > = {}
) =>
  new DaprWorkflowAgentRunner({
    agent: fakeMastraAgent(),
    name: 'support-agent',
    ...overrides,
  });

describe('DaprWorkflowAgentRunner', () => {
  it('derives the canonical workflow name from the agent name', () => {
    expect(newRunner().workflowName).toBe('dapr.mastra.SupportAgent.workflow');
    expect(newRunner({ name: 'billing bot' }).workflowName).toBe(
      'dapr.mastra.BillingBot.workflow'
    );
  });

  it('requires a name', () => {
    expect(() => newRunner({ name: '' })).toThrow(/non-empty agent name/);
  });

  it('starts out created, not running', () => {
    const runner = newRunner();
    expect(runner.status).toBe('created');
    expect(runner.isRunning).toBe(false);
  });

  it('exposes a Mastra mapper and matching metadata', async () => {
    const runner = newRunner();
    const metadata = await runner.getMetadata();

    expect(runner.mapper.framework).toBe('Mastra');
    // The metadata's workflowName must equal the name the runner registers
    // under — that identity is the whole reason the runner owns the name.
    expect(metadata.workflowName).toBe(runner.workflowName);
    expect(metadata.name).toBe('support-agent');
    expect(metadata.llm.model).toBe('gpt-4o-mini');
  });

  it('defaults maxIterations and honours an override', () => {
    expect(newRunner().maxIterations).toBe(25);
    expect(newRunner({ maxIterations: 5 }).maxIterations).toBe(5);
  });

  it('rejects workflow-client calls before start() with an actionable error', () => {
    const runner = newRunner();

    return expect(runner.terminateWorkflow('wf-1')).rejects.toThrow(
      /is not started — call start\(\)/
    );
  });

  it('is a no-op to shut down a runner that never started', async () => {
    const runner = newRunner();
    await expect(runner.shutdown()).resolves.toBeUndefined();
    expect(runner.status).toBe('created');
  });

  it('provides a checkpointer bound to the runner state store', () => {
    const runner = newRunner();
    expect(runner.checkpointer.storeName).toBe('agent-memory');
  });

  it('removes its signal handlers when the disposer is called', () => {
    const before = process.listenerCount('SIGTERM');
    const dispose = newRunner().registerShutdownHandlers();

    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    dispose();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});

// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * `invoke()`'s result handling.
 *
 * This file exists because of a bug that survived 143 tests: `invoke()` passed
 * `state.serializedOutput` — a JSON **string**, as the SDK's own naming says —
 * straight into a Zod *object* schema, so it threw on every completed workflow.
 * Nothing caught it because `invoke()` needs a workflow client, and no test had
 * one; the only code path that would have exercised it is an example actually
 * executing a workflow, which none of them did.
 *
 * The fix is small. The lesson is that `requireClient()` made this whole branch
 * untestable by default, so the fake below deliberately makes it testable
 * without a sidecar.
 */

import { describe, expect, it } from 'vitest';

import { WorkflowRuntimeStatus, type WorkflowState } from '@diagrid/agent-core';
import {
  DaprWorkflowAgentRunner,
  WorkflowStatus,
  type AgentWorkflowOutput,
} from '@diagrid/agent-mastra';

import { fakeMastraAgent } from '../fixtures/mastra-agent';

const COMPLETED_OUTPUT: AgentWorkflowOutput = {
  text: 'I found 2 results.',
  messages: [
    { role: 'user', content: 'search for X' },
    { role: 'assistant', content: 'I found 2 results.' },
  ],
  iterations: 1,
  status: WorkflowStatus.COMPLETED,
};

/** The slice of `DaprWorkflowClient` that `invoke()` touches. */
interface FakeClient {
  scheduleNewWorkflow(): Promise<string>;
  waitForWorkflowCompletion(): Promise<WorkflowState | undefined>;
}

/**
 * A runner with an injected workflow client.
 *
 * `workflowClient` is protected on `BaseWorkflowRunner`, so a subclass is the
 * supported way to stand one in — no sidecar, no gRPC channel.
 */
class TestableRunner extends DaprWorkflowAgentRunner {
  useClient(client: FakeClient): void {
    this.workflowClient = client as never;
  }
}

function runnerWith(state: WorkflowState | undefined): TestableRunner {
  const runner = new TestableRunner({
    agent: fakeMastraAgent(),
    name: 'support-agent',
  });
  runner.useClient({
    scheduleNewWorkflow: () => Promise.resolve('wf-1'),
    waitForWorkflowCompletion: () => Promise.resolve(state),
  });
  return runner;
}

/** A `WorkflowState`-shaped stub. The real class is all getters. */
function fakeState(overrides: {
  runtimeStatus?: WorkflowRuntimeStatus;
  serializedOutput?: string | undefined;
  failure?: { type: string; message: string };
}): WorkflowState {
  return {
    runtimeStatus: overrides.runtimeStatus ?? WorkflowRuntimeStatus.COMPLETED,
    serializedOutput: overrides.serializedOutput,
    workflowFailureDetails: overrides.failure
      ? {
          getErrorType: () => overrides.failure!.type,
          getErrorMessage: () => overrides.failure!.message,
          getStackTrace: () => undefined,
        }
      : undefined,
  } as unknown as WorkflowState;
}

const invokeInput = {
  prompt: 'search for X',
  threadId: 't1',
  messages: [],
  maxIterations: 10,
};

describe('DaprWorkflowAgentRunner.invoke', () => {
  it('parses the serialized output of a completed workflow', async () => {
    // The regression: `serializedOutput` is a JSON string, so it has to be
    // parsed before it reaches the schema.
    const runner = runnerWith(
      fakeState({ serializedOutput: JSON.stringify(COMPLETED_OUTPUT) })
    );

    await expect(runner.invoke(invokeInput)).resolves.toEqual(COMPLETED_OUTPUT);
  });

  it('reports a failed workflow with its status and error details', async () => {
    // Dapr signals failure through runtimeStatus, not by rejecting the wait —
    // so without an explicit check this surfaced as an opaque schema error.
    const runner = runnerWith(
      fakeState({
        runtimeStatus: WorkflowRuntimeStatus.FAILED,
        failure: { type: 'Error', message: 'invokeModel exploded' },
      })
    );

    await expect(runner.invoke(invokeInput)).rejects.toThrow(
      /ended with status FAILED: Error: invokeModel exploded/
    );
  });

  it('reports a terminated workflow', async () => {
    const runner = runnerWith(
      fakeState({ runtimeStatus: WorkflowRuntimeStatus.TERMINATED })
    );

    await expect(runner.invoke(invokeInput)).rejects.toThrow(
      /ended with status TERMINATED/
    );
  });

  it('reports a completed workflow that produced no output', async () => {
    const runner = runnerWith(fakeState({ serializedOutput: undefined }));

    await expect(runner.invoke(invokeInput)).rejects.toThrow(
      /completed without producing output/
    );
  });

  it('reports non-JSON output rather than a schema error', async () => {
    const runner = runnerWith(fakeState({ serializedOutput: '{not json' }));

    await expect(runner.invoke(invokeInput)).rejects.toThrow(
      /output that is not valid JSON/
    );
  });

  it('rejects output that parses but does not match the schema', async () => {
    // Guards the boundary the schema exists for: this value came back from the
    // state store, i.e. from outside the process.
    const runner = runnerWith(
      fakeState({ serializedOutput: JSON.stringify({ text: 42 }) })
    );

    await expect(runner.invoke(invokeInput)).rejects.toThrow();
  });

  it('reports a timeout distinctly from a failure', async () => {
    const runner = runnerWith(undefined);

    await expect(runner.invoke(invokeInput)).rejects.toThrow(
      /did not complete within \d+s/
    );
  });
});

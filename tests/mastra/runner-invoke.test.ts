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
  type ScheduledWorkflowInput,
  WorkflowTimeoutError,
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

/**
 * The slice of `DaprWorkflowClient` that `invoke()` touches.
 *
 * `scheduleNewWorkflow` takes its real parameters rather than none: what the
 * runner *sends* is half of what this file is here to check, and a zero-arg fake
 * silently discarded it.
 */
interface FakeClient {
  scheduleNewWorkflow(
    name: string,
    input?: unknown,
    id?: string
  ): Promise<string>;
  // Declared with its real parameters, like `scheduleNewWorkflow` above and for
  // the same reason: a zero-arg fake silently discarded the instance id, so
  // waiting on a bogus id was indistinguishable from waiting on a correct one.
  waitForWorkflowCompletion(
    id: string,
    fetchPayloads?: boolean,
    timeoutInSeconds?: number
  ): Promise<WorkflowState | undefined>;
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

  it('reports a missing instance when the wait resolves undefined', async () => {
    // The SDK resolves `undefined` only when no such instance exists — the
    // recovery path where `waitFor()` is given a purged or mistyped id. It does
    // NOT mean timeout, which this used to claim.
    const runner = runnerWith(undefined);

    await expect(runner.invoke(invokeInput)).rejects.toThrow(
      /No workflow instance "wf-1" exists/
    );
  });

  it('lets a transport failure through instead of calling it a timeout', async () => {
    // The SDK re-throws gRPC failures down the same path as its own timeout.
    // Wrapping them all told the operator "it is still running, reattach or
    // terminate it" when the sidecar was simply unreachable — sending them to
    // look for an instance rather than at their connection.
    const runner = new TestableRunner({
      agent: fakeMastraAgent(),
      name: 'support-agent',
    });
    const transportFailure = new Error(
      '14 UNAVAILABLE: No connection established'
    );
    runner.useClient({
      scheduleNewWorkflow: () => Promise.resolve('wf-1'),
      waitForWorkflowCompletion: () => Promise.reject(transportFailure),
    });

    const error = await runner.invoke(invokeInput).catch((e: unknown) => e);

    expect(error).toBe(transportFailure);
    expect(error).not.toBeInstanceOf(WorkflowTimeoutError);
  });

  it('reports a timeout with the workflow id attached', async () => {
    // A real timeout *rejects* — `waitForOrchestrationCompletion` races a timer
    // and rethrows. Untranslated it surfaced as `Error: TimeoutError` with no id
    // and no duration, because TimeoutError never sets `name`.
    const runner = new TestableRunner({
      agent: fakeMastraAgent(),
      name: 'support-agent',
    });
    runner.useClient({
      scheduleNewWorkflow: () => Promise.resolve('wf-1'),
      waitForWorkflowCompletion: () =>
        Promise.reject(new Error('TimeoutError')),
    });

    const error = await runner.invoke(invokeInput).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkflowTimeoutError);
    expect((error as WorkflowTimeoutError).workflowId).toBe('wf-1');
    expect((error as Error).message).toMatch(/did not complete within \d+s/);
    // The id matters: the workflow is still running and still billing.
    expect((error as Error).message).toMatch(/runner\.waitFor/);
  });
});

describe('schedule', () => {
  /** Capture the input the runner hands to Dapr. */
  function capturingRunner(options: { maxIterations?: number } = {}): {
    runner: TestableRunner;
    sent: () => Partial<ScheduledWorkflowInput>;
    sentName: () => string | undefined;
    sentId: () => string | undefined;
    waitedId: () => string | undefined;
  } {
    const seen: unknown[] = [];
    const sentName: string[] = [];
    const sentId: (string | undefined)[] = [];
    const waitedId: string[] = [];
    const runner = new TestableRunner({
      agent: fakeMastraAgent(),
      name: 'support-agent',
      ...options,
    });
    // The fake takes its real parameters. A version that dropped the name and
    // the instance id let two regressions through the whole gate: the caller's
    // `workflowId` never reaching Dapr (verbatim the bug `schedule()`'s own doc
    // describes as having shipped once — run 2 quietly restarted work run 1 had
    // finished), and `this.workflowName` replaced by a name no worker
    // registered. The zero-arg `waitForWorkflowCompletion` had the same hole:
    // waiting on a bogus id was indistinguishable from waiting on a real one.
    runner.useClient({
      scheduleNewWorkflow: (name: string, input, workflowId?: string) => {
        sentName.push(name);
        sentId.push(workflowId);
        seen.push(input);
        return Promise.resolve(workflowId ?? 'wf-1');
      },
      waitForWorkflowCompletion: (id: string) => {
        waitedId.push(id);
        return Promise.resolve(
          fakeState({ serializedOutput: JSON.stringify(COMPLETED_OUTPUT) })
        );
      },
    });
    return {
      runner,
      sent: () => seen[0] as Partial<ScheduledWorkflowInput>,
      sentName: () => sentName[0],
      sentId: () => sentId[0],
      waitedId: () => waitedId[0],
    };
  }

  it("passes the caller's workflowId through as the Dapr instance id", async () => {
    const { runner, sentId } = capturingRunner({});

    await runner.schedule(
      { prompt: 'go', threadId: 't1' },
      {
        workflowId: 'thread-t1',
      }
    );

    expect(sentId()).toBe('thread-t1');
  });

  it('waits on the instance id it just scheduled', async () => {
    const { runner, sentId, waitedId } = capturingRunner({});

    await runner.invoke(
      { prompt: 'go', threadId: 't1' },
      {
        workflowId: 'thread-t1',
      }
    );

    expect(sentId()).toBe('thread-t1');
    expect(waitedId()).toBe('thread-t1');
  });

  it('schedules under the workflow name this runner registered', async () => {
    const { runner, sentName } = capturingRunner({});

    await runner.schedule({ prompt: 'go', threadId: 't1' });

    // Not a literal: the name is derived, and a worker only services names it
    // registered. Compared against the runner's own accessor so the two cannot
    // drift apart silently.
    expect(sentName()).toBe(runner.workflowName);
    expect(sentName()).toContain('mastra');
  });

  it("applies the runner's maxIterations when the caller omits it", async () => {
    // Nothing captured what was sent before this, so the runner's own
    // maxIterations was silently dropped and every turn used the schema default.
    const { runner, sent } = capturingRunner({ maxIterations: 5 });

    await runner.schedule({ prompt: 'go', threadId: 't1' });

    expect(sent().maxIterations).toBe(5);
  });

  it('lets the caller override it', async () => {
    const { runner, sent } = capturingRunner({ maxIterations: 5 });

    await runner.schedule({ prompt: 'go', threadId: 't1', maxIterations: 9 });

    expect(sent().maxIterations).toBe(9);
  });

  it('does not let an explicit undefined win over the runner default', async () => {
    // Object spread cannot tell "absent" from "present and undefined", which is
    // what callers building input from a Partial produce.
    const { runner, sent } = capturingRunner({ maxIterations: 5 });

    await runner.schedule({
      prompt: 'go',
      threadId: 't1',
      maxIterations: undefined,
    });

    expect(sent().maxIterations).toBe(5);
  });

  it('scopes the activity names to this agent', async () => {
    // Two runners on one sidecar register on separate worker streams; under
    // shared names either could service the other's work with its own tools.
    const { runner, sent } = capturingRunner();

    await runner.schedule({ prompt: 'go', threadId: 't1' });

    expect(sent().activityNames).toEqual({
      model: 'diagrid.mastra.invokeModel.support-agent',
      tool: 'diagrid.mastra.invokeTool.support-agent',
    });
  });
});

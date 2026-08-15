// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * What `registerWorkflowComponents` hands to Dapr.
 *
 * This was the least-covered code in the package and the most consequential:
 * the closures registered here are the fix for two bugs that a passing test
 * suite did not see.
 *
 * - Invokers used to live in a **module-level registry**, so a second runner in
 *   the same process overwrote the first's and silently answered its durable
 *   turns with the wrong agent's tools.
 * - The activity **names** were shared literals, so even with per-runner
 *   invokers two runners on one sidecar could service each other's work items.
 *
 * `runner.test.ts` avoids `start()` because it opens a real gRPC channel, but
 * this hook is synchronous and takes the runtime as a parameter — so a fake is
 * enough, and none of this needs a sidecar.
 */

import { describe, expect, it } from 'vitest';

import type {
  WorkflowActivityContext,
  WorkflowRuntime,
} from '@diagrid/agent-core';
import {
  ACTIVITY_INVOKE_MODEL,
  ACTIVITY_INVOKE_TOOL,
  DaprWorkflowAgentRunner,
  type InvokeModelInput,
  type InvokeModelOutput,
} from '@diagrid/agent-mastra';

import { fakeMastraAgent } from '../fixtures/mastra-agent';

type Activity = (ctx: WorkflowActivityContext, input: unknown) => unknown;

/** Records what was registered, in place of the real Dapr runtime. */
function fakeRuntime(): {
  runtime: WorkflowRuntime;
  workflows: Map<string, unknown>;
  activities: Map<string, Activity>;
} {
  const workflows = new Map<string, unknown>();
  const activities = new Map<string, Activity>();

  const runtime = {
    registerWorkflowWithName: (name: string, fn: unknown) => {
      workflows.set(name, fn);
    },
    registerActivityWithName: (name: string, fn: Activity) => {
      activities.set(name, fn);
    },
  } as unknown as WorkflowRuntime;

  return { runtime, workflows, activities };
}

/** `registerWorkflowComponents` is protected — a subclass is how to drive it. */
class TestableRunner extends DaprWorkflowAgentRunner {
  register(runtime: WorkflowRuntime): void {
    this.registerWorkflowComponents(runtime);
  }
}

function runnerNamed(name: string): TestableRunner {
  return new TestableRunner({ agent: fakeMastraAgent(), name });
}

const MODEL_INPUT: InvokeModelInput = {
  messages: [{ role: 'user', content: 'hello' }],
  iteration: 0,
  threadId: 't1',
};

describe('registerWorkflowComponents', () => {
  it('registers the workflow under its canonical name', () => {
    const { runtime, workflows } = fakeRuntime();
    const runner = runnerNamed('support-agent');

    runner.register(runtime);

    expect([...workflows.keys()]).toEqual([runner.workflowName]);
  });

  it('scopes the activity names to the agent', () => {
    const { runtime, activities } = fakeRuntime();

    runnerNamed('support-agent').register(runtime);

    expect(activities.has('diagrid.mastra.invokeModel.support-agent')).toBe(
      true
    );
    expect(activities.has('diagrid.mastra.invokeTool.support-agent')).toBe(
      true
    );
  });

  it('does not register the unscoped names', () => {
    // A migration shim briefly registered these as aliases, so an instance
    // scheduled before scoping existed could still resolve activities. It was
    // removed: the sidecar has no way to route by registration — a worker sends
    // a bare Hello and then takes any work item for the app-id — so a shared
    // alias means two runners in one process can answer each other's legacy
    // work with the wrong agent's tools. That is precisely the bug scoping
    // fixed, and the shim traded it for nothing: an unregistered activity does
    // not hang, it comes back "not registered", is retried, and ends the turn
    // FAILED with that message.
    const { runtime, activities } = fakeRuntime();

    runnerNamed('support-agent').register(runtime);

    expect(activities.has(ACTIVITY_INVOKE_MODEL)).toBe(false);
    expect(activities.has(ACTIVITY_INVOKE_TOOL)).toBe(false);
  });

  it('gives two runners disjoint activity names', () => {
    // The whole point of scoping: agent A's work item must not be servable by
    // agent B's registration.
    const a = fakeRuntime();
    const b = fakeRuntime();

    runnerNamed('billing-agent').register(a.runtime);
    runnerNamed('support-agent').register(b.runtime);

    // Every registered name, unfiltered. An earlier version filtered on
    // '-agent' before comparing, which silently excluded the one thing that
    // could overlap — the unscoped literals — from a disjointness check.
    const overlap = [...a.activities.keys()].filter((name) =>
      b.activities.has(name)
    );

    expect(overlap).toEqual([]);
  });

  it('reads the model invoker on every call, not once at registration', () => {
    // `setModelInvoker()` is how `crash-recovery.ts` interrupts a turn, and it
    // is called *after* start() has already registered. Capturing the invoker
    // by value at registration would make that a silent no-op.
    const { runtime, activities } = fakeRuntime();
    const runner = runnerNamed('support-agent');
    runner.register(runtime);

    const replacement: InvokeModelOutput = {
      message: { role: 'assistant', content: 'from the replacement' },
      requiresToolCalls: false,
    };
    runner.setModelInvoker(() => Promise.resolve(replacement));

    const activity = activities.get('diagrid.mastra.invokeModel.support-agent');

    return expect(
      activity?.({} as WorkflowActivityContext, MODEL_INPUT)
    ).resolves.toMatchObject({
      message: { content: 'from the replacement' },
    });
  });

  it('reports an unknown tool rather than throwing', async () => {
    // Tool invokers are loaded in start(), which this test does not call, so
    // the map is empty — the same state as a tool that was removed between
    // scheduling and replay. That has to come back as a tool error the model
    // can react to, not an activity failure that burns retries.
    const { runtime, activities } = fakeRuntime();
    runnerNamed('support-agent').register(runtime);

    const activity = activities.get('diagrid.mastra.invokeTool.support-agent');
    const output = await activity?.({} as WorkflowActivityContext, {
      toolCallId: 'call-1',
      toolName: 'searchDocs',
      args: '{}',
      threadId: 't1',
    });

    expect(output).toMatchObject({
      toolCallId: 'call-1',
      error: expect.stringContaining('searchDocs'),
    });
  });
});

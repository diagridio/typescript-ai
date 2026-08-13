// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Example: a failing tool recovered from without losing the turn.
 *
 * What this actually demonstrates — verified by running it, which is why the
 * description is narrower than you might expect:
 *
 * The tool throws twice. Each failure is reported back to the *model* as a tool
 * error, and the model corrects and calls again; the third attempt succeeds and
 * it answers. Crucially, every completed step before each failure — the earlier
 * model calls and their tool results — was checkpointed as a Dapr activity, so
 * none of it is recomputed and none of those LLM calls is paid for twice.
 *
 * What it does **not** demonstrate is Dapr retrying the activity itself. The
 * tool bridge deliberately converts a thrown tool error into a tool *result*
 * carrying `error`, because a bad argument is information the model can act on,
 * not an infrastructure failure. The cost is that a genuinely transient failure
 * (rate limit, dropped connection) also goes to the model instead of being
 * retried in place.
 *
 * TODO(mastra-adapter): schedule activities with an explicit Dapr `RetryPolicy`
 * and let infrastructure errors propagate as activity failures, so transient
 * faults are retried without involving the model at all. Requires distinguishing
 * tool-logic errors from transport errors — see `packages/mastra/src/bridge.ts`.
 *
 * Run — local Dapr:
 *   dapr run --app-id mastra-retry --resources-path ./resources -- pnpm retry
 *
 * Run — Diagrid Catalyst (components come from the project, so no resources path):
 *   diagrid dev run --app-id mastra-retry -- pnpm retry
 *
 */

import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { DaprWorkflowAgentRunner } from '@diagrid/agent-mastra';
import { z } from 'zod';

import { resolveExampleModel } from './model';
import { describeSidecar, requireSidecar } from './sidecar';
import { resolveStateStore, resolveStoreName } from './store';

/** Fail this many times before succeeding. */
const FAILURES_BEFORE_SUCCESS = 2;

/**
 * Attempt counter, held in module state.
 *
 * Deliberately in-process: it must survive activity retries (which stay inside
 * one process) but reset if the process dies, so the numbers you see map
 * directly to retry attempts rather than to workflow replays.
 */
let attempts = 0;

const flakyLookup = createTool({
  id: 'flakyLookup',
  description: 'Look up an order. Occasionally fails and must be retried.',
  inputSchema: z.object({ orderId: z.string() }),
  outputSchema: z.object({ orderId: z.string(), status: z.string() }),
  execute: ({ orderId }) => {
    attempts += 1;

    if (attempts <= FAILURES_BEFORE_SUCCESS) {
      console.log(`Attempt ${attempts}: failing on purpose`);
      // A thrown error surfaces as an activity failure, which is what Dapr
      // retries. Compare with crash-recovery.ts, which kills the process.
      throw new Error(
        `Transient upstream failure (attempt ${attempts} of ${FAILURES_BEFORE_SUCCESS + 1})`
      );
    }

    console.log(`Attempt ${attempts}: succeeding`);
    return Promise.resolve({ orderId, status: 'shipped' });
  },
});

async function main(): Promise<void> {
  // Fail fast with an actionable message instead of an ECONNREFUSED stack.
  const sidecar = requireSidecar('mastra-retry', 'retry');
  console.log(`Connected via: ${describeSidecar(sidecar)}`);
  console.log(`State store:   ${resolveStoreName()}`);

  const agent = new Agent({
    id: 'retry-demo-agent',
    name: 'retry-demo-agent',
    instructions:
      'Look up the order the user asks about and report its status. ' +
      'Use the flakyLookup tool.',
    model: resolveExampleModel(),
    tools: { flakyLookup },
  });

  const runner = new DaprWorkflowAgentRunner({
    agent,
    name: 'retry-demo-agent',
    maxIterations: 10,
    stateStore: resolveStateStore(),
  });

  try {
    await runner.start();
    console.log(
      `Expecting ${FAILURES_BEFORE_SUCCESS} failures before the tool succeeds.\n`
    );

    const result = await runner.invoke({
      prompt: 'What is the status of order A-1234?',
      threadId: 'retry-demo',
      maxIterations: 10,
      messages: [],
    });

    console.log('\n' + '='.repeat(60));
    console.log(`Status:        ${result.status}`);
    console.log(`Tool attempts: ${attempts}`);
    console.log(`Model calls:   ${result.iterations}`);
    console.log(
      `\nThe tool failed ${FAILURES_BEFORE_SUCCESS} times and the turn still ` +
        'completed: each failure went back to the model as a tool error, which ' +
        'corrected and called again.\n' +
        'Every completed step in between was a checkpointed Dapr activity, so ' +
        'no earlier model call or tool result was recomputed.'
    );
    console.log('='.repeat(60));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nFailed: ${message}`);
    throw error;
  } finally {
    await runner.shutdown();
  }
}

await main();

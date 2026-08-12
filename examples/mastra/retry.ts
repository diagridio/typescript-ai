// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Example: a flaky tool retried without restarting the agent turn.
 *
 * The distinction this demonstrates matters in production. A tool that fails
 * transiently — a rate limit, a dropped connection — is retried *as an
 * activity*. The agent's control loop does not restart, the conversation is not
 * replayed, and the model is not called again. Without durable execution, the
 * usual fallback is to re-run the whole turn and pay for every prior LLM call a
 * second time.
 *
 * Run — local Dapr:
 *   dapr run --app-id mastra-retry --resources-path ./resources -- pnpm retry
 *
 * Run — Diagrid Catalyst (components come from the project, so no resources path):
 *   diagrid dev run --app-id mastra-retry -- pnpm retry
 *
 * ## Status
 *
 * Blocked on the model/tool bridges, like `simple-agent.ts`. The flaky tool and
 * its attempt counter are real; what is missing is the adapter code that hands
 * a tool call to Mastra.
 *
 * Note also that the retry *policy* itself is still open: the workflow
 * currently schedules activities with Dapr's defaults. Wiring an explicit
 * `RetryPolicy` is a `TODO(mastra-adapter)` in
 * `packages/mastra/src/workflow.ts`.
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
      '\nThe tool was retried in place — the agent loop did not restart, so the ' +
        'model was not re-invoked for the retried attempts.'
    );
    console.log('='.repeat(60));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not implemented yet')) {
      console.error(`\nThe adapter is still a scaffold: ${message}`);
      console.error(
        'This demo needs the model and tool bridges in ' +
          'packages/mastra/src/ (grep for TODO(mastra-adapter)).'
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await runner.shutdown();
  }
}

await main();

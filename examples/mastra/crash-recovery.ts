// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Example: prove the agent survives its process being killed mid-turn.
 *
 * This is the whole point of running an agent on Dapr Workflows, so it is worth
 * demonstrating rather than asserting. Mirrors
 * `examples/strands/test_crash_recovery.py` in `diagridio/python-ai`.
 *
 * Run it twice, on either path. Clear the state file first so run 1 starts clean.
 *
 * Local Dapr:
 *   rm -f "${TMPDIR:-/tmp}/diagrid-mastra-crash-state.json"
 *   dapr run --app-id mastra-crash --resources-path ./resources -- pnpm crash-recovery
 *   dapr run --app-id mastra-crash --resources-path ./resources -- pnpm crash-recovery
 *
 * Diagrid Catalyst (components come from the project, so no resources path):
 *   rm -f "${TMPDIR:-/tmp}/diagrid-mastra-crash-state.json"
 *   diagrid dev run --app-id mastra-crash -- pnpm crash-recovery
 *   diagrid dev run --app-id mastra-crash -- pnpm crash-recovery
 *
 * ## How the crash is triggered, and why not from a tool
 *
 * The crash happens inside the **second model call**, from a wrapper around the
 * adapter's own model invoker. That is deliberate, and it took a rewrite to get
 * right:
 *
 * An earlier version asked the model to call a tool three times and killed the
 * process during the second call. It never crashed, because a 7B model does not
 * reliably chain three tool calls — the run just completed with no tool calls at
 * all. Correctness of the demo depended on model behaviour, which is exactly the
 * wrong thing to depend on.
 *
 * Crashing from the model wrapper needs the model to make only **one** tool call,
 * and the crash point is decided by our own counter rather than by the model. It
 * also lands in the right place: by then the first model call and the tool call
 * have both completed and been checkpointed as Dapr activities, so run 2 must
 * replay them from history rather than recompute them. The counters in the state
 * file are what prove it — `modelCalls` growing by one on run 2 is expected — that is the interrupted
 * call completing for real. `toolRuns` growing is the failure: it would mean a
 * checkpointed result was recomputed instead of replayed, which is the one
 * thing this script checks.
 *
 * `setModelInvoker` is public API and `runner.modelInvoker` is the adapter's real
 * implementation, so the wrapper below delegates rather than faking a model.
 *
 * ## The workflow id matters
 *
 * `invoke()` is called with an explicit, stable `workflowId`. Without one Dapr
 * assigns a fresh instance id per call, so run 2 would start a brand-new turn
 * instead of resuming the interrupted one — it would produce a correct-looking
 * answer while silently recomputing everything. That is precisely the bug this
 * example exposed in the adapter, and the counters below are what exposed it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import {
  DaprWorkflowAgentRunner,
  type InvokeModelInput,
} from '@diagrid/agent-mastra';
import { z } from 'zod';

import { resolveExampleModel } from './model';
import { describeSidecar, requireSidecar } from './sidecar';
import { resolveStateStore, resolveStoreName } from './store';

const STATE_FILE = join(tmpdir(), 'diagrid-mastra-crash-state.json');
/** Reusing one thread id across runs is what lets Dapr resume the same turn. */
const THREAD_ID = 'crash-recovery-demo';
/** Crash during this model call. 2 = after the first model call and tool call. */
const CRASH_ON_MODEL_CALL = 2;

interface CrashState {
  runCount: number;
  /** Model calls that actually reached the provider, across all runs. */
  modelCalls: number;
  /** Tool executions that actually ran a body, across all runs. */
  toolRuns: number;
  crashed: boolean;
}

function loadState(): CrashState {
  if (!existsSync(STATE_FILE)) {
    return { runCount: 0, modelCalls: 0, toolRuns: 0, crashed: false };
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as CrashState;
}

function saveState(state: CrashState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const startState = loadState();
startState.runCount += 1;
saveState(startState);

const lookupOrder = createTool({
  id: 'lookupOrder',
  description: 'Look up the status of an order by its id.',
  inputSchema: z.object({ orderId: z.string().describe('The order id') }),
  outputSchema: z.object({ orderId: z.string(), status: z.string() }),
  execute: ({ orderId }) => {
    const state = loadState();
    state.toolRuns += 1;
    saveState(state);
    console.log(`Tool ran (total across runs: ${state.toolRuns})`);
    return Promise.resolve({ orderId, status: 'shipped' });
  },
});

async function main(): Promise<void> {
  const sidecar = requireSidecar('mastra-crash', 'crash-recovery');

  console.log('='.repeat(60));
  console.log(`RUN #${startState.runCount}`);
  console.log(`Connected via:   ${describeSidecar(sidecar)}`);
  console.log(`State store:     ${resolveStoreName()}`);
  console.log(`State file:      ${STATE_FILE}`);
  console.log(`Model calls:     ${startState.modelCalls} so far`);
  console.log(`Tool runs:       ${startState.toolRuns} so far`);
  console.log(`Already crashed: ${startState.crashed}`);
  console.log('='.repeat(60));

  const agent = new Agent({
    id: 'crash-demo-agent',
    name: 'crash-demo-agent',
    instructions:
      'You look up order statuses. Always use the lookupOrder tool to answer, ' +
      'then report the status in one short sentence.',
    model: resolveExampleModel(),
    tools: { lookupOrder },
  });

  const runner = new DaprWorkflowAgentRunner({
    agent,
    name: 'crash-demo-agent',
    maxIterations: 10,
    stateStore: resolveStateStore(),
  });

  try {
    await runner.start();

    // Wrap the runner's own invoker with a counter. `setModelInvoker` is the
    // supported hook; the runner reads it through an accessor, so replacing it
    // after `start()` takes effect for activities already registered.
    const realInvoker = runner.modelInvoker;
    runner.setModelInvoker(async (input: InvokeModelInput) => {
      const state = loadState();

      if (state.modelCalls + 1 === CRASH_ON_MODEL_CALL && !state.crashed) {
        state.crashed = true;
        saveState(state);
        console.log(
          `\n>>> Killing the process during model call ${CRASH_ON_MODEL_CALL}, ` +
            'before it returns.\n>>> Run the script again — Dapr will resume this ' +
            'workflow.'
        );
        // Un-catchable, like a real crash: the activity never completes, so Dapr
        // has to recover the instance rather than just retrying a failure.
        process.exit(1);
      }

      state.modelCalls += 1;
      saveState(state);
      console.log(`Model call ${state.modelCalls} (total across runs)`);
      return realInvoker(input);
    });

    // The stable workflow id is what ties the two runs to one turn.
    const workflowId = `crash-demo-${THREAD_ID}`;

    // Run 1 schedules the turn. Run 2 must NOT schedule again: the interrupted
    // instance is still active, so Dapr rejects a second schedule with the same
    // id ("an active workflow with ID ... already exists"). Recovery is
    // automatic — the engine redelivers the pending work as soon as this
    // process's worker reconnects — so all run 2 has to do is attach and wait.
    const result = startState.crashed
      ? await runner.waitFor(workflowId)
      : await runner.invoke(
          {
            prompt: 'What is the status of order A-1234?',
            threadId: THREAD_ID,
            maxIterations: 10,
            messages: [],
          },
          { workflowId }
        );

    const finalState = loadState();
    console.log('\n' + '='.repeat(60));
    console.log(`Status:      ${result.status}`);
    console.log(`Iterations:  ${result.iterations}`);
    console.log(`Answer:      ${result.text}`);
    console.log(`Model calls: ${finalState.modelCalls} (across all runs)`);
    console.log(`Tool runs:   ${finalState.toolRuns} (across all runs)`);

    if (finalState.runCount > 1) {
      // The actual proof. The turn needed two model calls and one tool call; if
      // recovery replayed history correctly, the work completed before the crash
      // was not redone, so the tool ran exactly once across both runs.
      const toolRedone = finalState.toolRuns > 1;
      console.log(
        toolRedone
          ? '\n❌ The tool ran more than once — completed work was recomputed.'
          : '\n✅ Recovery confirmed: the tool ran exactly once across both runs.\n' +
              '   Its result was replayed from workflow history, not recomputed.'
      );
    }
    console.log('='.repeat(60));
  } finally {
    await runner.shutdown();
  }
}

await main();

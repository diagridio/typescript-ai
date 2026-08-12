// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Example: prove the agent survives a crash mid-turn.
 *
 * This is the whole point of running an agent on Dapr Workflows, so it is worth
 * demonstrating rather than asserting. Mirrors
 * `examples/strands/test_crash_recovery.py` in `diagridio/python-ai`.
 *
 * How it works — two runs of the same script:
 *
 *   Run 1  The agent starts a turn. `crashAfterFirstTool` lets the first tool
 *          call complete, records that in a state file, then hard-kills the
 *          process (`process.exit`) partway through the second one.
 *   Run 2  Dapr resumes the same workflow instance from its last checkpoint.
 *          The state file shows tool 1 is *not* re-executed — its result came
 *          back from the workflow history instead of being recomputed.
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
 * ## Status
 *
 * Blocked on the same model/tool bridges as `simple-agent.ts`: without them the
 * turn never reaches a tool call, so run 1 exits before it can crash. The
 * harness, the state file and the workflow-id reuse are all real and will work
 * unchanged once the bridges land.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { DaprWorkflowAgentRunner } from '@diagrid/agent-mastra';
import { z } from 'zod';

import { resolveExampleModel } from './model';
import { describeSidecar, requireSidecar } from './sidecar';
import { resolveStateStore, resolveStoreName } from './store';

const STATE_FILE = join(tmpdir(), 'diagrid-mastra-crash-state.json');
/** Reusing one thread id across runs is what lets Dapr resume the same turn. */
const THREAD_ID = 'crash-recovery-demo';

interface CrashState {
  runCount: number;
  toolsExecuted: string[];
  crashed: boolean;
}

function loadState(): CrashState {
  if (!existsSync(STATE_FILE)) {
    return { runCount: 0, toolsExecuted: [], crashed: false };
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as CrashState;
}

function saveState(state: CrashState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const state = loadState();
state.runCount += 1;
saveState(state);

/**
 * A tool that kills the process the first time it is asked to run *second*.
 *
 * The crash is deliberately un-catchable (`process.exit`, not a thrown error):
 * a thrown error would exercise Dapr's activity retry, which is a different
 * mechanism. This proves recovery from a dead process.
 */
const crashAfterFirstTool = createTool({
  id: 'recordStep',
  description: 'Record a step of a multi-step task. Call it once per step.',
  inputSchema: z.object({ step: z.string().describe('Name of the step') }),
  outputSchema: z.object({ recorded: z.string() }),
  execute: ({ step }) => {
    const current = loadState();

    if (current.toolsExecuted.includes(step)) {
      // Replay safety net: if this ever fires, the workflow re-executed a
      // completed activity, which would mean durability is broken.
      console.error(
        `DURABILITY VIOLATION: step "${step}" executed twice ` +
          `(already recorded in ${STATE_FILE})`
      );
      process.exit(2);
    }

    current.toolsExecuted.push(step);
    saveState(current);
    console.log(
      `Executed step "${step}" (${current.toolsExecuted.length} so far)`
    );

    if (current.toolsExecuted.length === 2 && !current.crashed) {
      current.crashed = true;
      saveState(current);
      console.log(
        '\n>>> Hard-killing the process mid-turn. Run the script again.'
      );
      process.exit(1);
    }

    return Promise.resolve({ recorded: step });
  },
});

async function main(): Promise<void> {
  // Fail fast with an actionable message instead of an ECONNREFUSED stack.
  const sidecar = requireSidecar('mastra-crash', 'crash-recovery');
  console.log(`Connected via: ${describeSidecar(sidecar)}`);
  console.log(`State store:   ${resolveStoreName()}`);

  console.log('='.repeat(60));
  console.log(`RUN #${state.runCount}`);
  console.log(`State file:      ${STATE_FILE}`);
  console.log(`Steps so far:    ${state.toolsExecuted.join(', ') || '(none)'}`);
  console.log(`Already crashed: ${state.crashed}`);
  console.log('='.repeat(60));

  const agent = new Agent({
    id: 'crash-demo-agent',
    name: 'crash-demo-agent',
    instructions:
      'Complete the task by calling recordStep once for each step, in order. ' +
      'Do not skip a step and do not call it twice for the same step.',
    model: resolveExampleModel(),
    tools: { recordStep: crashAfterFirstTool },
  });

  const runner = new DaprWorkflowAgentRunner({
    agent,
    name: 'crash-demo-agent',
    maxIterations: 10,
    stateStore: resolveStateStore(),
  });

  try {
    await runner.start();

    const result = await runner.invoke({
      prompt: 'Record these steps in order: alpha, beta, gamma.',
      threadId: THREAD_ID,
      maxIterations: 10,
      messages: [],
    });

    console.log('\n' + '='.repeat(60));
    console.log(`Status:          ${result.status}`);
    console.log(`Steps executed:  ${loadState().toolsExecuted.join(', ')}`);
    if (state.runCount > 1) {
      console.log(
        '\nRecovery confirmed: the steps completed before the crash were not ' +
          're-executed — their results were replayed from workflow history.'
      );
    }
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

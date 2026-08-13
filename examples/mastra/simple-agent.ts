// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Example: one durable Mastra agent turn on Dapr Workflows.
 *
 * The agent's control loop runs as a Dapr Workflow: every model call and every
 * tool execution is a checkpointed activity, so killing this process mid-turn
 * and restarting it resumes from the last completed activity instead of
 * re-running the turn (and re-paying for the LLM calls).
 *
 * Prerequisites:
 *   1. Dapr initialized:  dapr init
 *   2. Dependencies:      pnpm install   (from the repo root)
 *   3. OPENAI_API_KEY set — or OLLAMA_ENDPOINT to use a local model instead
 *
 * Run — local Dapr:
 *   dapr run --app-id mastra-simple --resources-path ./resources -- pnpm simple
 *
 * Run — Diagrid Catalyst (components come from the project, so no resources path):
 *   diagrid dev run --app-id mastra-simple -- pnpm simple
 *
 * Expect two iterations for the prompt below: one model call that asks for the
 * `calculate` and `getWeather` tools, then a second that turns their results into
 * an answer. Each of those steps is a separate checkpointed activity.
 */

import { Agent } from '@mastra/core/agent';
import { DaprWorkflowAgentRunner } from '@diagrid/agent-mastra';

import { describeExampleModel, resolveExampleModel } from './model';
import { describeSidecar, requireSidecar } from './sidecar';
import { resolveStateStore, resolveStoreName } from './store';
import { demoTools } from './tools';

const THREAD_ID = 'demo-thread-001';

async function main(): Promise<void> {
  // Fail fast with an actionable message instead of an ECONNREFUSED stack.
  const sidecar = requireSidecar('mastra-simple', 'simple');
  console.log(`Connected via: ${describeSidecar(sidecar)}`);
  console.log(`State store:   ${resolveStoreName()}`);

  const model = resolveExampleModel();

  const agent = new Agent({
    id: 'support-agent',
    name: 'support-agent',
    instructions:
      'You are a helpful assistant with access to web search, arithmetic and ' +
      'weather tools. Use them when they would make your answer more accurate.',
    model,
    tools: demoTools,
  });

  const runner = new DaprWorkflowAgentRunner({
    agent,
    name: 'support-agent',
    maxIterations: 10,
    stateStore: resolveStateStore(),
  });

  // Opt in to clean shutdown on Ctrl-C. A library must not install
  // process-wide signal handlers on your behalf, so this is explicit.
  const disposeHandlers = runner.registerShutdownHandlers();

  try {
    console.log(`Model: ${describeExampleModel(model)}`);
    console.log('Starting the Dapr Workflow runtime...');
    await runner.start();
    console.log(`Registered "${runner.workflowName}".\n`);

    const result = await runner.invoke({
      prompt: "What's 21 times 2, and what's the weather in San Francisco?",
      threadId: THREAD_ID,
      maxIterations: 10,
      messages: [],
    });

    console.log('='.repeat(60));
    console.log(`Status:     ${result.status}`);
    console.log(`Iterations: ${result.iterations}`);
    console.log(`Answer:     ${result.text}`);
    console.log('='.repeat(60));
  } finally {
    disposeHandlers();
    await runner.shutdown();
    console.log('Runtime shut down.');
  }
}

await main();

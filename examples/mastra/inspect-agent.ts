// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Example: inspect what Diagrid publishes about a Mastra agent.
 *
 * This is the only example that needs neither a model nor a sidecar, which
 * makes it the first thing to run when something looks misconfigured: it
 * answers "what does Diagrid think this agent is?" without executing a turn.
 * The other three run real durable turns — see `./README.md`.
 *
 * It prints the canonical workflow name and the full registry record: the
 * framework, the resolved model and provider, and the agent's tools. That
 * record is exactly what a Catalyst project renders for the agent, so this is
 * the fastest way to check that an agent is configured the way you think.
 *
 * No API key and no Dapr sidecar required:
 *
 *     pnpm inspect
 *
 * Run it with a sidecar attached and it additionally starts the workflow runtime,
 * which proves the workflow and its activities register cleanly. Both run paths
 * work:
 *
 *     # Local Dapr (components from ./resources)
 *     dapr run --app-id mastra-inspect --resources-path ./resources -- pnpm inspect
 *
 *     # Diagrid Catalyst (components from the Catalyst project)
 *     diagrid dev run --app-id mastra-inspect -- pnpm inspect
 */

import { Agent } from '@mastra/core/agent';
import { DaprWorkflowAgentRunner } from '@diagrid/agent-mastra';

import { describeExampleModel, resolveExampleModel } from './model';
import { describeSidecar, detectSidecar, runCommands } from './sidecar';
import { resolveStateStore, resolveStoreName } from './store';
import { demoTools } from './tools';

async function main(): Promise<void> {
  const model = resolveExampleModel();

  const agent = new Agent({
    id: 'support-agent',
    name: 'support-agent',
    instructions: 'You help customers with billing questions.',
    model,
    tools: demoTools,
  });

  const runner = new DaprWorkflowAgentRunner({
    agent,
    name: 'support-agent',
    maxIterations: 10,
    stateStore: resolveStateStore(),
  });

  const sidecar = detectSidecar();

  console.log(`Model:         ${describeExampleModel(model)}`);
  console.log(`State store:   ${resolveStoreName()}`);
  console.log(`Connected via: ${describeSidecar(sidecar)}`);
  console.log(`Workflow name: ${runner.workflowName}`);
  console.log('\nRegistry record:');
  // `getMetadata()` is async because Mastra exposes an agent's tools only via
  // `listTools()`, which returns a Promise.
  console.log(JSON.stringify(await runner.getMetadata(), null, 2));

  // Without a sidecar, starting the runtime would fail on a gRPC channel that
  // never connects, so only try it when one is attached — by either path.
  if (sidecar === 'none') {
    console.log(
      '\nNo sidecar detected. To also verify workflow registration:\n\n' +
        runCommands('mastra-inspect', 'inspect')
    );
    return;
  }

  console.log(
    `\nSidecar detected (${sidecar}) — starting the workflow runtime...`
  );
  await runner.start();
  console.log(`Registered "${runner.workflowName}" and its activities.`);
  await runner.shutdown();
  console.log('Runtime shut down cleanly.');
}

await main();

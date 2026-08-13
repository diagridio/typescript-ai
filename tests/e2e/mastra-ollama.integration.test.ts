// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * End-to-end lane: a real model behind a real Dapr sidecar.
 *
 * Counterpart of `tests/e2e/test_*_ollama.py` in `diagridio/python-ai`. Driven
 * by `.github/workflows/e2e-ollama.yaml`, which installs Ollama, pulls a small
 * model, sets up Docker and `dapr init` before running
 * `pnpm test:integration`.
 *
 * ## Prerequisites and skipping
 *
 * The suite skips unless `OLLAMA_ENDPOINT` is set. Set
 * `DIAGRID_E2E_REQUIRED=1` (as CI does) to turn a missing prerequisite into a
 * failure instead — otherwise absent infrastructure could green a gated run,
 * which is the one thing an e2e lane must never do.
 *
 * ## Status
 *
 * This file covers the adapter's model *configuration* against a live Ollama —
 * that the endpoint is reachable and the workflow-name contract holds. The full
 * durable turn is covered by `mastra-examples.integration.test.ts`, which runs
 * the examples under `dapr run`.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { Agent } from '@mastra/core/agent';

import {
  createModelInvoker,
  DaprWorkflowAgentRunner,
} from '@diagrid/agent-mastra';

const OLLAMA_ENDPOINT = process.env['OLLAMA_ENDPOINT'];
const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] ?? 'qwen3:0.6b';
const E2E_REQUIRED = process.env['DIAGRID_E2E_REQUIRED'] === '1';

if (E2E_REQUIRED && !OLLAMA_ENDPOINT) {
  throw new Error(
    'DIAGRID_E2E_REQUIRED=1 but OLLAMA_ENDPOINT is unset — the e2e lane would ' +
      'have skipped silently. Check the Ollama setup step in e2e-ollama.yaml.'
  );
}

describe.skipIf(!OLLAMA_ENDPOINT)('Mastra adapter e2e (Ollama)', () => {
  const agent = {
    name: 'e2e-agent',
    instructions: 'Answer in one short sentence.',
    model: {
      specificationVersion: 'v2',
      modelId: OLLAMA_MODEL,
      provider: 'ollama-ai-provider',
      baseURL: OLLAMA_ENDPOINT,
    },
  };

  beforeAll(async () => {
    // Fail fast and with a useful message: a 20-minute lane should not spend
    // its budget discovering that the model server never came up.
    const response = await fetch(`${OLLAMA_ENDPOINT}/models`);
    if (!response.ok) {
      throw new Error(
        `Ollama at ${OLLAMA_ENDPOINT} returned ${response.status} — model server not ready`
      );
    }
  });

  it('reports the configured model in registry metadata', async () => {
    const runner = new DaprWorkflowAgentRunner({ agent, name: 'e2e-agent' });
    const metadata = await runner.getMetadata();

    expect(metadata.llm.provider).toBe('ollama');
    expect(metadata.llm.model).toBe(OLLAMA_MODEL);
    expect(metadata.llm.baseUrl).toBe(OLLAMA_ENDPOINT);
  });

  it('registers under the canonical workflow name', () => {
    const runner = new DaprWorkflowAgentRunner({ agent, name: 'e2e-agent' });
    expect(runner.workflowName).toBe('dapr.mastra.E2eAgent.workflow');
  });

  it('reaches the model directly, proving the endpoint is usable', async () => {
    // Not going through the adapter yet — this is the baseline the adapter will
    // be measured against once the model bridge exists.
    const response = await fetch(`${OLLAMA_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: 'user', content: 'Say hello in one word.' }],
      }),
    });

    expect(response.ok).toBe(true);
    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    expect(body.choices?.[0]?.message?.content).toBeTruthy();
  });

  it('the model bridge produces an assistant message from the live model', async () => {
    // The bridge without Dapr in the way: one model call, real provider. Proves
    // the transcript conversion and response mapping independently of the
    // workflow, which `mastra-examples.integration.test.ts` covers.
    //
    // A *real* Agent, not the plain-object fixture the metadata tests use: the
    // bridge calls `generate()`, and rightly refuses anything that lacks it.
    const realAgent = new Agent({
      id: 'e2e-agent',
      name: 'e2e-agent',
      instructions: 'Answer in one short word.',
      model: {
        id: `ollama/${OLLAMA_MODEL}`,
        url: OLLAMA_ENDPOINT!,
        apiKey: 'ollama',
      },
    });

    const output = await createModelInvoker(realAgent)({
      messages: [{ role: 'user', content: 'Say hello in one word.' }],
      toolNames: [],
      iteration: 0,
      threadId: 'e2e-thread',
    });

    expect(output.message.role).toBe('assistant');
    expect(output.message.content.length).toBeGreaterThan(0);
    expect(output.requiresToolCalls).toBe(false);
  });
});

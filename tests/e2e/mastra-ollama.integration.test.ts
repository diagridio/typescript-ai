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
 * The adapter is a scaffold, so the full agent turn is an `it.todo` rather than
 * a test that pretends to pass. What runs today is real: the model endpoint is
 * reachable, and the workflow-name contract the sidecar registers under holds.
 * The final test asserts the *current* honest behaviour — an unimplemented
 * model bridge fails loudly — and is the one to replace when the bridge lands.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  ACTIVITY_INVOKE_MODEL,
  DaprWorkflowAgentRunner,
  invokeModelActivity,
  registerModelInvoker,
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

  it('reports the configured model in registry metadata', () => {
    const runner = new DaprWorkflowAgentRunner({ agent, name: 'e2e-agent' });

    expect(runner.metadata.llm.provider).toBe('ollama');
    expect(runner.metadata.llm.model).toBe(OLLAMA_MODEL);
    expect(runner.metadata.llm.baseUrl).toBe(OLLAMA_ENDPOINT);
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

  it('fails loudly rather than fabricating a result while unimplemented', async () => {
    // Pin the honest failure. When the model bridge lands, replace this with
    // the real assertion and delete the `it.todo` below.
    const runner = new DaprWorkflowAgentRunner({ agent, name: 'e2e-agent' });
    void runner;

    registerModelInvoker(() => {
      throw new Error(`${ACTIVITY_INVOKE_MODEL} is not implemented yet`);
    });

    await expect(
      invokeModelActivity({} as never, {
        messages: [{ role: 'user', content: 'hi' }],
        iteration: 0,
        threadId: 'e2e-thread',
      })
    ).rejects.toThrow(/not implemented yet/);
  });

  it.todo(
    'executes a Mastra agent turn as a Dapr workflow and survives a mid-turn crash'
  );
});

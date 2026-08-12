// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Runtime coverage for `examples/mastra/`.
 *
 * `tsc --build` already type-checks the examples, which stops them drifting from
 * the adapter's *types*. It cannot catch an example that compiles and then
 * crashes, prints nothing useful, or silently reports the wrong model. So this
 * suite actually executes them.
 *
 * It runs in the integration lane, which means both
 * `.github/workflows/integration.yaml` (nightly) and
 * `.github/workflows/e2e-ollama.yaml` pick it up via `pnpm test:integration` —
 * no extra workflow needed. When `OLLAMA_ENDPOINT` is set, the model-config
 * assertions additionally prove the Ollama plumbing end to end.
 *
 * Scripts are spawned through the example package's own `tsx` binary rather
 * than through `pnpm run`, so the suite does not depend on a package manager
 * being on `PATH`.
 *
 * ## What is asserted today
 *
 * `inspect-agent.ts` is fully verified — it is the one example that completes
 * while the model and tool bridges are stubs — including that it recognizes both
 * run paths: local `dapr run` (`DAPR_GRPC_PORT`) and Catalyst `diagrid dev run`
 * (`DAPR_GRPC_ENDPOINT`).
 *
 * For the other three, the assertion is that they fail *actionably*: naming both
 * run paths, with no gRPC stack trace and no claim of success. When the bridges
 * land, replace those with real output assertions and drop the `it.todo`s.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EXAMPLE_DIR = join(REPO_ROOT, 'examples', 'mastra');
const TSX = join(EXAMPLE_DIR, 'node_modules', '.bin', 'tsx');

const OLLAMA_ENDPOINT = process.env['OLLAMA_ENDPOINT'];
const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] ?? 'qwen3:0.6b';

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run an example script, capturing output and exit code.
 *
 * `overrides` opts back into a sidecar shape for the detection tests. A script
 * given an unreachable endpoint will sit in gRPC retries forever, so those runs
 * get a short timeout — the assertion is about what it *printed* before that.
 */
async function runExample(
  script: string,
  overrides: Record<string, string> = {},
  timeout = 120_000
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(TSX, [script], {
      cwd: EXAMPLE_DIR,
      env: {
        ...process.env,
        // Explicitly no OPENAI_API_KEY: nothing here should need a real key, and
        // an inherited one would mask a script that silently calls a provider.
        OPENAI_API_KEY: '',
        // Detach from any sidecar the caller happens to be under. Without this,
        // running `pnpm test:integration` inside `dapr run` or `diagrid dev run`
        // would inherit DAPR_GRPC_PORT / DAPR_GRPC_ENDPOINT and take a
        // completely different branch than CI does.
        DAPR_GRPC_PORT: '',
        DAPR_GRPC_ENDPOINT: '',
        DAPR_HTTP_ENDPOINT: '',
        DAPR_API_TOKEN: '',
        ...overrides,
      },
      timeout,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

/** Pull the registry record out of a script's stdout. */
function parseMetadata(stdout: string): Record<string, any> {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  expect(start, 'no JSON object found in stdout').toBeGreaterThan(-1);
  return JSON.parse(stdout.slice(start, end + 1)) as Record<string, any>;
}

beforeAll(() => {
  // A clearer failure than "ENOENT: tsx" if someone runs this without installing.
  expect(
    existsSync(TSX),
    `tsx not found at ${TSX} — run pnpm install from the repo root`
  ).toBe(true);
});

describe('examples/mastra: inspect-agent.ts', () => {
  it('runs to completion with no sidecar and no API key', async () => {
    const result = await runExample('inspect-agent.ts');

    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('dapr.mastra.SupportAgent.workflow');
    // Without a sidecar it must say so rather than hanging on a gRPC channel...
    expect(result.stdout).toContain('No sidecar detected');
    expect(result.stdout).toContain('Connected via: no sidecar');
    // ...and it must offer BOTH run paths, not just local Dapr. Catalyst is the
    // managed path these adapters exist to support, and it is configured
    // differently (DAPR_GRPC_ENDPOINT, no --resources-path).
    expect(result.stdout).toContain(
      'dapr run --app-id mastra-inspect --resources-path ./resources'
    );
    expect(result.stdout).toContain('diagrid dev run --app-id mastra-inspect');
  });

  it.each([
    {
      label: 'local Dapr',
      env: { DAPR_GRPC_PORT: '50001' },
      shows: 'local Dapr sidecar',
    },
    {
      label: 'Catalyst',
      env: {
        DAPR_GRPC_ENDPOINT: 'https://unreachable.invalid:443',
        DAPR_API_TOKEN: 'test-token',
      },
      shows: 'Diagrid Catalyst',
    },
  ])(
    'detects a $label sidecar from the environment',
    async ({ env, shows }) => {
      // Regression: the first version of the sidecar check looked only at
      // DAPR_GRPC_PORT, which Catalyst never sets — so `diagrid dev run` was
      // rejected as "no sidecar". Both shapes must be recognized.
      //
      // The endpoints are deliberately unreachable: this asserts detection and
      // reporting, not connectivity, so the script is killed once it has printed.
      const result = await runExample('inspect-agent.ts', env, 20_000);

      expect(`${result.stdout}\n${result.stderr}`).toContain(shows);
      expect(result.stdout).not.toContain('No sidecar detected');
    }
  );

  it('reports the agent configuration truthfully', async () => {
    const metadata = parseMetadata(
      (await runExample('inspect-agent.ts')).stdout
    );

    expect(metadata['workflowName']).toBe('dapr.mastra.SupportAgent.workflow');
    expect(metadata['agent'].framework).toBe('Mastra');

    // These four were all wrong before the mapper learned to read a real
    // Agent's private config through its class accessors. Empty instructions or
    // an empty tool list here is the regression to catch.
    expect(metadata['agent'].instructions).not.toHaveLength(0);
    expect(metadata['agent'].systemPrompt).not.toBe('');
    expect(metadata['tools'].map((t: { name: string }) => t.name)).toEqual([
      'searchWeb',
      'calculate',
      'getWeather',
    ]);
    expect(metadata['llm'].model).not.toBe('unknown');
    expect(metadata['llm'].provider).not.toBe('unknown');
  });

  it('every tool carries a JSON Schema for its arguments', async () => {
    const metadata = parseMetadata(
      (await runExample('inspect-agent.ts')).stdout
    );

    for (const tool of metadata['tools'] as { name: string; args: string }[]) {
      const args: unknown = JSON.parse(tool.args || '{}');
      expect(args, `tool ${tool.name} has no argument schema`).toMatchObject({
        type: 'object',
      });
    }
  });

  it.runIf(OLLAMA_ENDPOINT)(
    'resolves the Ollama endpoint from the environment',
    async () => {
      // Proves the OpenAI-compatible model-config path end to end: the example
      // builds `{ id: 'ollama/<model>', url }` and the mapper has to unpack it.
      const metadata = parseMetadata(
        (await runExample('inspect-agent.ts')).stdout
      );

      expect(metadata['llm'].provider).toBe('ollama');
      expect(metadata['llm'].model).toBe(OLLAMA_MODEL);
      expect(metadata['llm'].baseUrl).toBe(OLLAMA_ENDPOINT);
    }
  );
});

describe('examples/mastra: scripts that require a Dapr sidecar', () => {
  // These are spawned WITHOUT `dapr run`, so `DAPR_GRPC_PORT` is unset and the
  // sidecar guard fires. Deterministic regardless of whether Dapr is installed
  // on the runner, which is what makes it safe to assert on exact output.
  //
  // The assertions are deliberately specific. An earlier version matched
  // /not implemented yet|scaffold|DAPR|sidecar/i and passed — on a gRPC
  // ECONNREFUSED stack trace, because the DurableTask logger happens to print
  // "DAPR". A loose regex on a failure path asserts almost nothing.
  const cases = [
    { script: 'simple-agent.ts', appId: 'mastra-simple', run: 'simple' },
    {
      script: 'crash-recovery.ts',
      appId: 'mastra-crash',
      run: 'crash-recovery',
    },
    { script: 'retry.ts', appId: 'mastra-retry', run: 'retry' },
  ];

  it.each(cases)(
    '$script explains it needs a sidecar instead of dumping a gRPC error',
    async ({ script, appId, run }) => {
      const result = await runExample(script);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.code).not.toBe(0);
      expect(output).toContain('This example requires a Dapr sidecar');
      // The message has to be copy-pasteable, not just descriptive.
      expect(output).toContain(
        `dapr run --app-id ${appId} --resources-path ./resources -- pnpm ${run}`
      );

      // The failure must happen before any connection attempt: no gRPC noise,
      // no stack trace, and never a claim of success.
      expect(output).not.toMatch(/ECONNREFUSED|UNAVAILABLE|grpc-js/);
      expect(output).not.toMatch(/Status:\s+completed/);
    }
  );

  it.todo('simple-agent.ts prints a model answer once the bridge lands');
  it.todo('crash-recovery.ts resumes without re-executing completed tools');
  it.todo('retry.ts retries the flaky tool without re-invoking the model');
});

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
 * Without a sidecar: `inspect-agent.ts` must still complete and report the right
 * registry record, and must recognize both run paths — local `dapr run`
 * (`DAPR_GRPC_PORT`) and Catalyst `diagrid dev run` (`DAPR_GRPC_ENDPOINT`). The
 * three that need a sidecar must say so actionably, with no gRPC stack trace.
 *
 * With one (the `e2e-ollama` lane): the "durable execution" block below runs the
 * examples for real and asserts a turn actually completed.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EXAMPLE_DIR = join(REPO_ROOT, 'examples', 'mastra');
/**
 * The example package's own `tsx`.
 *
 * On Windows the pnpm bin shim is `tsx.cmd`, and Node refuses to `execFile` a
 * `.cmd` without a shell (a deliberate restriction since the 2024 argument-
 * injection fix), so both the filename and `shell` differ by platform. The
 * integration lane runs on windows-latest, so this is load-bearing, not
 * theoretical.
 */
const IS_WINDOWS = process.platform === 'win32';
const TSX = join(
  EXAMPLE_DIR,
  'node_modules',
  '.bin',
  IS_WINDOWS ? 'tsx.cmd' : 'tsx'
);

const OLLAMA_ENDPOINT = process.env['OLLAMA_ENDPOINT'];
const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] ?? 'qwen3:0.6b';

/**
 * Whether the Dapr CLI is usable, i.e. whether a workflow can actually run.
 *
 * `dapr run` needs an initialized Dapr (`dapr init`, which needs Docker), so the
 * probe invokes the CLI rather than merely looking for the binary.
 */
const HAS_DAPR = (() => {
  try {
    execFileSync('dapr', ['--version'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

/** The durable path needs both a sidecar and a model to be exercisable. */
const CAN_RUN_WORKFLOWS = HAS_DAPR && Boolean(OLLAMA_ENDPOINT);

/**
 * Refuse to skip silently when CI says this lane must run.
 *
 * The `durable execution` block below is the only automated check anywhere that
 * a workflow completes a turn — including the `Iterations: 0` guard for the sync
 * generator bug. It is gated on `describe.runIf`, so if `dapr --version` fails
 * for any reason (PATH, the install script changing shape) the whole block
 * vanishes and the job still reports green. That is precisely the
 * false-confidence failure `DIAGRID_E2E_REQUIRED` exists to prevent, and
 * `mastra-ollama.integration.test.ts` already honours it — this file did not.
 */
if (process.env['DIAGRID_E2E_REQUIRED'] === '1' && !CAN_RUN_WORKFLOWS) {
  throw new Error(
    'DIAGRID_E2E_REQUIRED=1 but the durable-execution block would have ' +
      `skipped (dapr CLI available: ${HAS_DAPR}, OLLAMA_ENDPOINT set: ` +
      `${Boolean(OLLAMA_ENDPOINT)}). Check the Dapr and Ollama setup steps.`
  );
}

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
      shell: IS_WINDOWS,
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

/**
 * The durable path, under a real sidecar.
 *
 * Everything else in this file runs the examples *without* Dapr, which checks
 * their preflight behaviour but never executes a workflow. This block does, and
 * it is the only automated check that would have caught the bug that shipped in
 * the first cut: a sync `function*` orchestrator, which Dapr silently completes
 * without running a single activity. The type-checker cannot see it, and the unit
 * tests drive the generator directly so they cannot either — the sole symptom is
 * an empty result.
 *
 * Runs in the `e2e-ollama` lane, which does `dapr init` and sets
 * `OLLAMA_ENDPOINT`. Skips elsewhere, including the Windows leg of
 * `integration.yaml`, which has no model.
 */
describe.runIf(CAN_RUN_WORKFLOWS)('examples/mastra: durable execution', () => {
  /** Run an example under `dapr run`, exactly as the README instructs. */
  async function runUnderDapr(
    appId: string,
    script: string,
    timeout = 600_000
  ): Promise<RunResult> {
    const args = [
      'run',
      '--app-id',
      appId,
      '--resources-path',
      './resources',
      '--log-level',
      'warn',
      '--',
      TSX,
      script,
    ];
    const env: Record<string, string | undefined> = {
      ...process.env,
      OLLAMA_ENDPOINT,
      OLLAMA_MODEL,
    };
    try {
      const { stdout, stderr } = await execFileAsync('dapr', args, {
        cwd: EXAMPLE_DIR,
        env,
        shell: IS_WINDOWS,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
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

  it('simple-agent.ts completes a real agent turn as a Dapr workflow', async () => {
    const result = await runUnderDapr('e2e-mastra-simple', 'simple-agent.ts');
    const output = `${result.stdout}\n${result.stderr}`;

    expect(output).toContain('Registered "dapr.mastra.SupportAgent.workflow"');
    expect(output).toMatch(/Status:\s+completed/);

    // The regression guard. A sync-generator orchestrator reports exactly
    // `Iterations: 0` alongside status completed, because Dapr marks the
    // instance complete without ever entering the loop.
    const iterations = Number(/Iterations:\s+(\d+)/.exec(output)?.[1] ?? '0');
    expect(
      iterations,
      'the workflow completed without running an iteration — is the ' +
        'orchestrator a sync function* instead of an async function*?'
    ).toBeGreaterThan(0);

    // A turn that ran must have produced text. Small models vary in wording,
    // so this asserts substance exists rather than what it says.
    const answer = /Answer:\s+(.*)/.exec(output)?.[1]?.trim() ?? '';
    expect(answer.length, `empty answer. output:\n${output}`).toBeGreaterThan(
      0
    );
  }, 620_000);

  it('retry.ts survives a failing tool without losing the turn', async () => {
    const result = await runUnderDapr('e2e-mastra-retry', 'retry.ts');
    const output = `${result.stdout}\n${result.stderr}`;

    expect(output).toMatch(/Status:\s+completed/);
    // The tool fails twice by design, so a completed turn proves the failures
    // were recovered from rather than swallowed.
    expect(output).toContain('Attempt 1: failing on purpose');
    expect(output).toContain('Attempt 3: succeeding');

    const attempts = Number(/Tool attempts:\s+(\d+)/.exec(output)?.[1] ?? '0');
    expect(attempts).toBeGreaterThanOrEqual(3);
  }, 620_000);
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

  // simple-agent and retry are covered for real by the "durable execution"
  // block above, which runs them under `dapr run`. Only crash recovery is still
  // unproven: it needs the model to chain several tool calls so the process can
  // be killed between two of them, and a 7B model does not do that reliably.
  it.todo('crash-recovery.ts resumes without re-executing completed tools');
});

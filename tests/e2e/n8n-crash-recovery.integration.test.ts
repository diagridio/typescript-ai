// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Automated counterpart of the manual crash-recovery proof this package's own
 * verification pass ran by hand: a real Dapr sidecar, a real, locally-built
 * n8n process, a workflow killed genuinely mid-node-execution, restarted with
 * zero manual trigger, and real `expect()` assertions on the result — not a
 * script that prints things for a human to read.
 *
 * ## Why this needs its own detection, unlike every other integration test here
 *
 * `mastra-examples.integration.test.ts` and `mastra-ollama.integration.test.ts`
 * both gate on infrastructure `integration.yaml`/`e2e-ollama.yaml` can
 * actually provision in CI (the Dapr CLI, Ollama). Neither CI workflow comes
 * anywhere close to providing what this file needs: a real, separately
 * built n8n monorepo checkout — an order of magnitude larger and slower to
 * provision than installing a CLI or pulling a small model, and nothing in
 * this repo's CI does anything like it today (confirmed by reading both
 * workflow files: `integration.yaml` explicitly runs with no Dapr CLI at
 * all, "deliberately"; `e2e-ollama.yaml` installs Ollama/Docker/Dapr but
 * never clones or builds an n8n checkout).
 *
 * So, deliberately unlike `mastra-examples.integration.test.ts`'s
 * `DIAGRID_E2E_REQUIRED` gate: this file does NOT turn a missing
 * prerequisite into a CI failure. `DIAGRID_E2E_REQUIRED` exists to catch a
 * lane that *should* have its infrastructure quietly not having it — no
 * current lane is supposed to have a real n8n checkout, so wiring that flag
 * in here would either do nothing (nobody sets it for this) or eventually
 * break `integration.yaml`/`e2e-ollama.yaml` the day someone naively adds it
 * there. This suite skips, with a clear reason logged, in every environment
 * that lacks the real thing — CI included, today and for the foreseeable
 * future — and only actually runs for a developer who has followed
 * `packages/n8n/README.md`'s "Developing against a local n8n checkout"
 * section.
 *
 * ## Availability
 *
 * Detected structurally, reusing the existing dev-setup convention rather
 * than inventing a new env var: `scripts/link-n8n-dev-deps.sh` symlinks a
 * real, built n8n checkout's packages into `packages/n8n/node_modules`. This
 * file resolves that symlink back to the checkout root (two directories up
 * from `n8n-core`'s real path) to find `packages/cli/bin/n8n`, and checks
 * `packages/cli/dist` exists as a proxy for "actually built", not just
 * cloned. `packages/n8n/dist/preload.cjs` must exist too (`pnpm build`).
 *
 * ## The kill pattern — no timing guesswork
 *
 * `DEMO.md`'s own history recorded a fixed sleep-then-kill as flaky; the fix
 * was blocking on a specific, deterministic log line before killing. This
 * test reuses exactly that: orchestrator-v2's own round-start log line
 * (`round-log.ts`) fires the instant a round's activities are dispatched,
 * before their real side effects run — blocking on `round 2 dispatching
 * [Set C]` (round 0 = Set A, round 1 = Set B) and killing immediately
 * guarantees Set C's activity is genuinely in flight, with a
 * `DIAGRID_N8N_DELAY_MS` window comfortably larger than the polling
 * granularity used to detect the line.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  N8nClient,
  type WorkflowDefinition,
} from './n8n-helpers/n8n-client.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGES_N8N_DIR = join(REPO_ROOT, 'packages', 'n8n');
const PRELOAD_CJS = join(PACKAGES_N8N_DIR, 'dist', 'preload.cjs');
const BYPASS_SHIM = join(
  REPO_ROOT,
  'tests',
  'e2e',
  'n8n-helpers',
  'node-version-bypass.cjs'
);
const RESOURCES_DIR = join(REPO_ROOT, 'examples', 'n8n', 'resources');

/** Same probe `mastra-examples.integration.test.ts` uses: is the CLI itself usable? */
const HAS_DAPR = (() => {
  try {
    execFileSync('dapr', ['--version'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

interface N8nCheckout {
  readonly root: string;
  readonly n8nBin: string;
}

/**
 * Resolves `scripts/link-n8n-dev-deps.sh`'s own symlink back to a real n8n
 * checkout root, rather than requiring a separate, new env var. Returns
 * `undefined` for any reason the checkout isn't usable — not found, not a
 * real symlink, or present but never built.
 */
function resolveN8nCheckout(): N8nCheckout | undefined {
  const n8nCoreLink = join(PACKAGES_N8N_DIR, 'node_modules', 'n8n-core');
  if (!existsSync(n8nCoreLink)) return undefined;

  let resolvedCore: string;
  try {
    resolvedCore = realpathSync(n8nCoreLink);
  } catch {
    return undefined;
  }

  // resolvedCore is <checkout>/packages/core
  const root = dirname(dirname(resolvedCore));
  const n8nBin = join(root, 'packages', 'cli', 'bin', 'n8n');
  const cliDist = join(root, 'packages', 'cli', 'dist');
  if (!existsSync(n8nBin) || !existsSync(cliDist)) return undefined;

  return { root, n8nBin };
}

const PRELOAD_BUILT = existsSync(PRELOAD_CJS);
const N8N_CHECKOUT = resolveN8nCheckout();
const CAN_RUN = HAS_DAPR && N8N_CHECKOUT !== undefined && PRELOAD_BUILT;

if (!CAN_RUN) {
  // Logged unconditionally (not inside a hook a skipped describe would never
  // run) so `pnpm test:integration` explains itself instead of silently
  // reporting one fewer test than expected.
  console.warn(
    '[n8n crash-recovery e2e] skipped — ' +
      `dapr CLI available: ${HAS_DAPR}, ` +
      `sibling n8n checkout linked and built: ${N8N_CHECKOUT !== undefined}, ` +
      `packages/n8n built: ${PRELOAD_BUILT}. ` +
      'See packages/n8n/README.md "Developing against a local n8n checkout" ' +
      "to set this up; no CI lane provisions it today (see this file's own " +
      'top-of-file comment for why that is a deliberate, not accidental, gap).'
  );
}

/**
 * Unique per test process, not a fixed literal — a real, reproduced failure
 * mode, not a theoretical one: a fixed app-id across runs left a genuinely
 * incomplete Dapr orchestration instance "1" in the sidecar's backing store
 * (Redis) from an earlier run that failed BEFORE restarting n8n. A later
 * run's fresh n8n execution "1" then collided with it —
 * `Error: 2 UNKNOWN: failed to create workflow instance: an active workflow
 * with ID '1' already exists` — exactly the DaprWorkflowAgentRunner.schedule()
 * doc comment's own warning (packages/mastra/src/runner.ts) and
 * `DEMO.md`'s own troubleshooting note about reusing state across attempts,
 * both confirmed for real here rather than just read about. A fresh app-id
 * per run makes this test self-cleaning: no reliance on `afterAll`'s own
 * best-effort cleanup having succeeded on whatever ran before it.
 */
const APP_ID = `diagrid-n8n-it-${process.pid}-${Date.now()}`;
const DAPR_HTTP_PORT = 3711;
const DAPR_GRPC_PORT = 50411;
/**
 * Comfortably larger than the log-line polling interval (50ms) below, with
 * margin for a slower machine — not tuned to the edge the way the manual
 * proof's 20s was for a human to react to.
 */
const DELAY_MS = 8_000;

function readTextSafe(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/**
 * Poll a growing log file for a line, rather than sleeping a fixed duration
 * — see this file's own top comment for why a fixed sleep was rejected.
 */
async function waitForLogLine(
  logPath: string,
  pattern: string,
  timeoutMs: number,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (readTextSafe(logPath).includes(pattern)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${logPath} to contain ${JSON.stringify(pattern)}. ` +
          `Last 2000 chars:\n${readTextSafe(logPath).slice(-2000)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Bounded polling for an async condition — never a single check-and-hope. */
async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 1_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

interface MarkerEntry {
  readonly nodeName: string;
  readonly attempt: number;
  readonly instanceId: string;
  readonly pid: number;
  readonly status: string;
}

function readMarkerLog(path: string): MarkerEntry[] {
  return readTextSafe(path)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MarkerEntry);
}

/**
 * Existence check via Dapr's own HTTP state API — bypasses this package's
 * code entirely.
 *
 * `res.ok` alone is not existence: confirmed directly (this returned `true`
 * for a key that provably did not exist yet, before this fix) — Dapr's HTTP
 * state GET returns 200 with an EMPTY body for a missing key, not 404. Same
 * behavior `@diagrid/agent-core`'s own `DaprStateStore.get()` doc comment
 * already documents ("Dapr returns an empty string (HTTP)... for a key that
 * does not exist") — this helper just hadn't applied it yet.
 */
async function ledgerKeyExists(key: string): Promise<boolean> {
  const res = await fetch(
    `http://localhost:${DAPR_HTTP_PORT}/v1.0/state/kvstore/${encodeURIComponent(key)}`
  );
  if (!res.ok) return false;
  const text = await res.text();
  return text.length > 0;
}

const WORKFLOW_NAME = 'diagrid-n8n-it-crash-recovery';

/**
 * Manual Trigger -> Set A -> Set B -> Set C, each adding one field and
 * keeping the rest (`includeOtherFields: true`) — the exact fixture shape
 * `n8n-dapr-durable`'s own `DEMO.md` used, so the final item accumulating
 * `step1`/`step2`/`step3` is itself evidence that work from before AND after
 * the crash both really happened.
 */
function workflowDefinition(): WorkflowDefinition {
  const setNode = (name: string, id: string, field: string, x: number) => ({
    id,
    name,
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position: [x, 0],
    parameters: {
      assignments: {
        assignments: [{ id: '1', name: field, type: 'string', value: 'done' }],
      },
      includeOtherFields: true,
      options: {},
    },
  });

  return {
    name: WORKFLOW_NAME,
    nodes: [
      {
        id: 'it-trigger',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      setNode('Set A', 'it-set-a', 'step1', 220),
      setNode('Set B', 'it-set-b', 'step2', 440),
      setNode('Set C', 'it-set-c', 'step3', 660),
    ],
    connections: {
      'Manual Trigger': { main: [[{ node: 'Set A', type: 'main', index: 0 }]] },
      'Set A': { main: [[{ node: 'Set B', type: 'main', index: 0 }]] },
      'Set B': { main: [[{ node: 'Set C', type: 'main', index: 0 }]] },
    },
    settings: {},
  };
}

describe.skipIf(!CAN_RUN)('n8n crash recovery (e2e)', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'diagrid-n8n-it-'));
  const n8nUserFolder = join(workDir, '.n8n');
  const markerFile = join(workDir, 'marker.log');
  const daprLog = join(workDir, 'dapr-sidecar.log');
  const n8nLogBeforeKill = join(workDir, 'n8n-before-kill.log');
  const n8nLogAfterRestart = join(workDir, 'n8n-after-restart.log');

  let daprProcess: ChildProcess | undefined;
  let n8nProcess: ChildProcess | undefined;

  function spawnN8n(logPath: string): ChildProcess {
    const logFd = openSync(logPath, 'a');
    const child = spawn(
      'node',
      [
        '--require',
        BYPASS_SHIM,
        '--require',
        PRELOAD_CJS,
        // Non-null: CAN_RUN (this describe block's own gate) already proved
        // N8N_CHECKOUT is defined — no eslint-disable needed, this file
        // matches tests/**/*.ts, where no-non-null-assertion is already off.
        N8N_CHECKOUT!.n8nBin,
        'start',
      ],
      {
        cwd: workDir,
        env: {
          ...process.env,
          // A real, previously-undiscovered finding, confirmed by actually
          // running this rather than assuming inherited env is harmless:
          // Vitest sets NODE_ENV=test on its own process, which this child
          // would otherwise inherit — and a real n8n process started with
          // NODE_ENV=test hangs silently right after connecting to Dapr,
          // never reaching "No encryption key found"/"Initializing n8n
          // process"/migrations at all (confirmed directly: identical to a
          // plain `node bin/n8n start` run with NODE_ENV=test set by hand,
          // and confirmed fixed the same way — overriding it back to
          // "production" here, even with NODE_ENV=test in the parent shell,
          // restores the exact real-boot sequence DEMO.md's own runs saw).
          // Not investigated further — not this package's own code, and
          // orthogonal to what this test proves — but real and load-bearing
          // enough that skipping this override reintroduces a 60s+ hang.
          NODE_ENV: 'production',
          DAPR_HTTP_PORT: String(DAPR_HTTP_PORT),
          DAPR_GRPC_PORT: String(DAPR_GRPC_PORT),
          N8N_USER_FOLDER: n8nUserFolder,
          N8N_DIAGNOSTICS_ENABLED: 'false',
          DIAGRID_N8N_MARKER_FILE: markerFile,
          DIAGRID_N8N_DELAY_NODE_NAME: 'Set C',
          DIAGRID_N8N_DELAY_MS: String(DELAY_MS),
        },
        stdio: ['ignore', logFd, logFd],
      }
    );
    n8nProcess = child;
    return child;
  }

  function killIfAlive(child: ChildProcess | undefined): void {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }

  beforeAll(async () => {
    console.log(`[n8n crash-recovery e2e] work dir: ${workDir}`);

    // Best-effort: clear any stale sidecar left over from a previously killed
    // run under the same app-id, so ports/actor state don't collide.
    try {
      execFileSync('dapr', ['stop', '--app-id', APP_ID], { stdio: 'ignore' });
    } catch {
      // Nothing was running — expected on a clean run.
    }

    daprProcess = spawn(
      'dapr',
      [
        'run',
        '--app-id',
        APP_ID,
        '--resources-path',
        RESOURCES_DIR,
        '--dapr-http-port',
        String(DAPR_HTTP_PORT),
        '--dapr-grpc-port',
        String(DAPR_GRPC_PORT),
        '--',
        'sh',
        '-c',
        'while true; do sleep 3600; done',
      ],
      { stdio: ['ignore', openSync(daprLog, 'a'), openSync(daprLog, 'a')] }
    );

    await waitForLogLine(daprLog, "You're up and running", 30_000, 200);
  }, 60_000);

  afterAll(() => {
    // Runs even when an assertion above threw — vitest always runs afterAll
    // for a describe block it has entered. Both kills are independent of
    // each other so one failing can't strand the other, mirroring
    // runtime.ts's own shutdown() pattern.
    killIfAlive(n8nProcess);
    try {
      execFileSync('dapr', ['stop', '--app-id', APP_ID], { stdio: 'ignore' });
    } catch {
      // Best-effort — `dapr run`'s own process is killed next regardless.
    }
    killIfAlive(daprProcess);
  });

  it('resumes a multi-node workflow after a mid-execution kill, with no duplicate side effects', async () => {
    // --- Boot #1 ---
    spawnN8n(n8nLogBeforeKill);
    await waitForLogLine(
      n8nLogBeforeKill,
      'Editor is now accessible',
      60_000,
      200
    );
    expect(readTextSafe(n8nLogBeforeKill)).toContain(
      `Successfully connected to dns:127.0.0.1:${DAPR_GRPC_PORT}`
    );

    // --- Create and trigger ---
    const client = new N8nClient('http://localhost:5678');
    await client.ensureLoggedIn();
    const workflowId = await client.findOrCreateWorkflow(workflowDefinition());
    const executionId = await client.trigger(workflowId);

    // --- The kill: block on the exact round-start line, not a sleep ---
    await waitForLogLine(
      n8nLogBeforeKill,
      'round 2 dispatching [Set C]',
      20_000,
      50
    );
    const pidBeforeKill = n8nProcess?.pid;
    killIfAlive(n8nProcess);

    // Set C's activity was genuinely in flight, never returned: no ledger
    // entry yet, and the marker log (written only on a real, completed
    // execute() call — see activity.ts's own doc comment) has exactly the
    // two nodes that finished before the kill.
    expect(await ledgerKeyExists(`diagrid.n8n:${executionId}:Set C:0:1`)).toBe(
      false
    );
    const preKillMarkers = readMarkerLog(markerFile);
    expect(preKillMarkers.map((m) => m.nodeName)).toEqual(['Set A', 'Set B']);
    expect(preKillMarkers.every((m) => m.pid === pidBeforeKill)).toBe(true);

    // --- Boot #2: restart, zero manual trigger ---
    spawnN8n(n8nLogAfterRestart);
    await waitForLogLine(
      n8nLogAfterRestart,
      `Successfully connected to dns:127.0.0.1:${DAPR_GRPC_PORT}`,
      60_000,
      200
    );
    const pidAfterRestart = n8nProcess?.pid;
    expect(pidAfterRestart).not.toBe(pidBeforeKill);

    // --- Resume, polled with a bounded retry loop, not sleep-and-check-once ---
    const execution = await pollUntil(
      async () => {
        const current = await client.getExecution(executionId);
        return current?.finished ? current : undefined;
      },
      90_000,
      2_000
    );

    // --- Real assertions on the real outcome ---
    expect(execution.status).toBe('success');

    const allMarkers = readMarkerLog(markerFile);
    expect(allMarkers.map((m) => m.nodeName).sort()).toEqual([
      'Set A',
      'Set B',
      'Set C',
    ]);
    // No duplicate execution of already-completed nodes: exactly one real
    // execute() per node, ever, across both processes.
    const byNode = new Map(allMarkers.map((m) => [m.nodeName, m]));
    expect(byNode.size).toBe(3);
    expect(byNode.get('Set A')?.pid).toBe(pidBeforeKill);
    expect(byNode.get('Set B')?.pid).toBe(pidBeforeKill);
    expect(byNode.get('Set C')?.pid).toBe(pidAfterRestart);
    expect(allMarkers.every((m) => m.status === 'success')).toBe(true);

    // Direct state-store inspection, bypassing this package's own code and
    // n8n's REST API both: exactly the ledger entries the run should have
    // produced, no more.
    for (const node of ['Set A', 'Set B', 'Set C']) {
      expect(
        await ledgerKeyExists(`diagrid.n8n:${executionId}:${node}:0:1`),
        `expected a ledger entry for ${node}`
      ).toBe(true);
    }
  }, 180_000);
});

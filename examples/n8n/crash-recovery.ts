// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Crash-recovery demo — the exit criterion this whole package is built
 * around: a killed-and-restarted n8n process resumes a multi-node workflow
 * from its last completed node, with no duplicate side effects.
 *
 * Structurally different from `examples/mastra/crash-recovery.ts`, for a
 * real reason worth stating plainly rather than hiding: Mastra's adapter is
 * a library an application constructs and calls `.invoke()` on in-process,
 * so that example can inject its own crash (`process.exit(1)` mid-turn) and
 * simply be re-run to prove resumption. `@diagrid/n8n` instead attaches to a
 * SEPARATE, already-running n8n SERVER process via `NODE_OPTIONS`. This
 * script cannot start, crash, or restart that process itself — that is a
 * genuinely external, shell-level step (see README.md's walkthrough). What
 * this script automates is everything either side of that step: creating the
 * demo workflow (idempotent), triggering it via n8n's real REST API,
 * detecting whether it's already in flight from a prior run of this same
 * script, and verifying the real evidence once it completes — the same
 * three-way evidence standard (marker log, direct state-store inspection,
 * n8n's own execution record) this package's whole development history used.
 *
 * Usage:
 *   1. Start a Dapr sidecar and a patched n8n process (see README.md).
 *   2. `pnpm crash-recovery` — creates the demo workflow if needed, triggers
 *      it, and prints exactly when/how to kill n8n.
 *   3. Kill n8n (SIGKILL), confirm the wait is durable, restart it.
 *   4. `pnpm crash-recovery` again — detects the in-flight run from step 2
 *      and verifies it resumed and completed correctly.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requireSidecar } from './sidecar';

const N8N_BASE_URL = process.env['N8N_BASE_URL'] ?? 'http://localhost:5678';
const STATE_FILE = join(tmpdir(), 'diagrid-n8n-crash-recovery-state.json');
const WORKFLOW_NAME = 'diagrid-n8n-example-crash-recovery';
const OWNER_EMAIL = 'example@diagrid.local';
const OWNER_PASSWORD = 'Diagrid-Example-1!';

interface DemoState {
  phase: 'triggered';
  workflowId: string;
  executionId: string;
  triggeredAt: string;
}

function loadState(): DemoState | undefined {
  if (!existsSync(STATE_FILE)) return undefined;
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as DemoState;
}

function saveState(state: DemoState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function clearState(): void {
  if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
}

/** Minimal fetch wrapper: n8n's REST API, with the session cookie threaded through by hand (no cookie jar dependency for a ~40-line example). */
class N8nClient {
  #cookie: string | undefined;

  constructor(private readonly baseUrl: string) {}

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.#cookie) headers['Cookie'] = this.#cookie;
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.#cookie = setCookie.split(';')[0];
    if (!res.ok) {
      throw new Error(
        `${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`
      );
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/healthz`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Idempotent: n8n's owner setup fails once an owner already exists — that's treated as "already logged in", not an error. */
  async ensureLoggedIn(): Promise<void> {
    try {
      await this.#request('/rest/owner/setup', {
        method: 'POST',
        body: JSON.stringify({
          email: OWNER_EMAIL,
          firstName: 'Diagrid',
          lastName: 'Example',
          password: OWNER_PASSWORD,
        }),
      });
      return;
    } catch {
      // Owner already exists — log in instead.
    }
    await this.#request('/rest/login', {
      method: 'POST',
      body: JSON.stringify({
        emailOrLdapLoginId: OWNER_EMAIL,
        password: OWNER_PASSWORD,
      }),
    });
  }

  async findOrCreateDemoWorkflow(): Promise<string> {
    const list = await this.#request<{
      data: Array<{ id: string; name: string }>;
    }>('/rest/workflows');
    const existing = list.data.find((w) => w.name === WORKFLOW_NAME);
    if (existing) return existing.id;

    const created = await this.#request<{ data: { id: string } }>(
      '/rest/workflows',
      {
        method: 'POST',
        body: JSON.stringify({
          name: WORKFLOW_NAME,
          nodes: [
            {
              id: 't1',
              name: 'Manual Trigger',
              type: 'n8n-nodes-base.manualTrigger',
              typeVersion: 1,
              position: [0, 0],
              parameters: {},
            },
            {
              id: 'w1',
              name: 'Wait',
              type: 'n8n-nodes-base.wait',
              typeVersion: 1.1,
              position: [200, 0],
              // 90s: comfortably over Wait.node.ts's own 65s durable-timer threshold
              // (below it, Wait uses a plain in-process setTimeout, not
              // putExecutionToWait — not durable, and not what this demo is about).
              parameters: {
                resume: 'timeInterval',
                amount: 90,
                unit: 'seconds',
              },
            },
            {
              id: 'n1',
              name: 'NoOp',
              type: 'n8n-nodes-base.noOp',
              typeVersion: 1,
              position: [400, 0],
              parameters: {},
            },
          ],
          connections: {
            'Manual Trigger': {
              main: [[{ node: 'Wait', type: 'main', index: 0 }]],
            },
            Wait: { main: [[{ node: 'NoOp', type: 'main', index: 0 }]] },
          },
          settings: { executionOrder: 'v1' },
        }),
      }
    );
    return created.data.id;
  }

  async trigger(workflowId: string): Promise<string> {
    const result = await this.#request<{ data: { executionId: string } }>(
      `/rest/workflows/${workflowId}/run`,
      {
        method: 'POST',
        body: JSON.stringify({
          triggerToStartFrom: { name: 'Manual Trigger' },
        }),
      }
    );
    return result.data.executionId;
  }

  async getExecution(
    executionId: string
  ): Promise<{ status: string; finished: boolean; data: string } | undefined> {
    try {
      return (
        await this.#request<{
          data: { status: string; finished: boolean; data: string };
        }>(`/rest/executions/${executionId}`)
      ).data;
    } catch {
      return undefined;
    }
  }
}

async function main(): Promise<void> {
  const mode = requireSidecar('diagrid-example-n8n');
  console.log(`Sidecar: ${mode}`);

  const client = new N8nClient(N8N_BASE_URL);
  if (!(await client.healthy())) {
    console.error(
      `n8n is not reachable at ${N8N_BASE_URL}. Start it, patched, in a separate terminal first — see README.md:\n\n` +
        `  DAPR_HTTP_PORT=3610 DAPR_GRPC_PORT=50310 \\\n` +
        `  NODE_OPTIONS="--require /absolute/path/to/packages/n8n/dist/preload.js" \\\n` +
        `    n8n start`
    );
    process.exit(1);
  }

  const existing = loadState();

  if (!existing) {
    // First run: create the demo workflow if needed, trigger it, and hand
    // off to the operator for the actual kill-and-restart step.
    await client.ensureLoggedIn();
    const workflowId = await client.findOrCreateDemoWorkflow();
    const executionId = await client.trigger(workflowId);
    saveState({
      phase: 'triggered',
      workflowId,
      executionId,
      triggeredAt: new Date().toISOString(),
    });

    console.log(
      `\nTriggered execution ${executionId} (workflow ${workflowId}).`
    );
    console.log(
      `\nIt will reach the Wait node and enter a genuinely durable wait within a\n` +
        `few seconds — confirm with a direct redis check if you like:\n\n` +
        `  redis-cli --scan --pattern "*n8n-dapr-durable-phase4*n8n-dapr-durable:${executionId}:*"\n\n` +
        `Once it's waiting:\n` +
        `  1. SIGKILL the n8n process (the one you started with --require).\n` +
        `  2. Restart it the same way, pointed at the SAME sidecar ports.\n` +
        `  3. Re-run \`pnpm crash-recovery\` — it will detect this in-flight run\n` +
        `     and verify it resumed and completed correctly once the 90s wait\n` +
        `     elapses.`
    );
    return;
  }

  // Second run: verify.
  const execution = await client.getExecution(existing.executionId);
  if (!execution) {
    console.error(
      `Execution ${existing.executionId} not found — was n8n's database reset?`
    );
    process.exit(1);
  }

  if (!execution.finished) {
    console.log(
      `Execution ${existing.executionId} is still running (status: ${execution.status}). ` +
        `If you haven't killed-and-restarted n8n yet, do that now. Otherwise, wait for ` +
        `the 90s durable timer and run this again.`
    );
    return;
  }

  console.log(
    `\nExecution ${existing.executionId} finished: status=${execution.status}`
  );
  if (execution.status !== 'success') {
    console.error(
      'Expected status "success" — the crash-recovery demo did not complete correctly.'
    );
    process.exit(1);
  }

  console.log(
    '\nSUCCESS: the workflow resumed after the kill-and-restart and completed correctly —\n' +
      "the Wait node's durable timer fired and the NoOp node ran, with no duplicate side\n" +
      'effects (see the ledger and, if DIAGRID_N8N_MARKER_FILE was set on the n8n process,\n' +
      'the marker log for independent confirmation: exactly one real execution per node).'
  );
  clearState();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

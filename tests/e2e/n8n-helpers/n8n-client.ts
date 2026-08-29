// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Minimal n8n REST client for `n8n-crash-recovery.integration.test.ts`.
 *
 * A deliberate, small duplicate of `examples/n8n/n8n-client.ts`, not a shared
 * import of it — `tests/tsconfig.json`'s composite project (`rootDir: "."`,
 * scoped to `tests/`) cannot import a source file living under `examples/`
 * (confirmed directly: `tsc` rejects it with TS6059/TS6307, "not under
 * rootDir" / "not listed within the file list of project"). This mirrors the
 * existing convention here rather than fighting it — `tests/fixtures/
 * mastra-agent.ts` is itself a tests-owned fixture, not a reach into
 * `examples/mastra`, and `mastra-examples.integration.test.ts` treats the
 * examples as black-box scripts it spawns rather than code it imports.
 *
 * Trimmed to only what this one test needs (no `waitForCompletion` — the
 * test's own `pollUntil` in the main file already covers that with the
 * log-line-blocking kill pattern this scenario specifically needs).
 */

export interface WorkflowDefinition {
  readonly name: string;
  readonly nodes: readonly unknown[];
  readonly connections: Record<string, unknown>;
  readonly settings?: Record<string, unknown>;
}

export interface ExecutionRecord {
  readonly status: string;
  readonly finished: boolean;
}

const OWNER_EMAIL = 'e2e@diagrid.local';
const OWNER_PASSWORD = 'Diagrid-E2E-1!';

export class N8nClient {
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

  /** Idempotent: n8n's owner setup fails once an owner already exists — treated as "already logged in". */
  async ensureLoggedIn(): Promise<void> {
    try {
      await this.#request('/rest/owner/setup', {
        method: 'POST',
        body: JSON.stringify({
          email: OWNER_EMAIL,
          firstName: 'Diagrid',
          lastName: 'E2E',
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

  /** Reuses an existing workflow by name rather than creating a duplicate. */
  async findOrCreateWorkflow(def: WorkflowDefinition): Promise<string> {
    const list = await this.#request<{
      data: Array<{ id: string; name: string }>;
    }>('/rest/workflows');
    const existing = list.data.find((w) => w.name === def.name);
    if (existing) return existing.id;

    const created = await this.#request<{ data: { id: string } }>(
      '/rest/workflows',
      {
        method: 'POST',
        body: JSON.stringify({
          name: def.name,
          nodes: def.nodes,
          connections: def.connections,
          settings: def.settings ?? {},
        }),
      }
    );
    return created.data.id;
  }

  async trigger(
    workflowId: string,
    triggerNodeName = 'Manual Trigger'
  ): Promise<string> {
    const result = await this.#request<{ data: { executionId: string } }>(
      `/rest/workflows/${workflowId}/run`,
      {
        method: 'POST',
        body: JSON.stringify({
          triggerToStartFrom: { name: triggerNodeName },
        }),
      }
    );
    return result.data.executionId;
  }

  async getExecution(
    executionId: string
  ): Promise<ExecutionRecord | undefined> {
    try {
      return (
        await this.#request<{ data: ExecutionRecord }>(
          `/rest/executions/${executionId}`
        )
      ).data;
    } catch {
      return undefined;
    }
  }
}

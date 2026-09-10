// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Minimal n8n REST client, shared by `crash-recovery.ts` and `regression.ts`
 * so the two scripts don't each duplicate cookie-session plumbing. Originally
 * lived inline in `crash-recovery.ts`; extracted once `regression.ts` needed
 * the same create-or-reuse-workflow / trigger / poll shape.
 *
 * No cookie-jar dependency for this much surface — the session cookie is
 * threaded through by hand, the same way the original inline version did.
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
  readonly data: string;
}

const OWNER_EMAIL = 'example@diagrid.local';
const OWNER_PASSWORD = 'Diagrid-Example-1!';

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

  /** Reuses an existing workflow by name rather than creating a duplicate on every run. */
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

  /** Polls until the execution reports `finished`, or the timeout elapses. */
  async waitForCompletion(
    executionId: string,
    { timeoutMs = 60_000, intervalMs = 1_000 } = {}
  ): Promise<ExecutionRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const execution = await this.getExecution(executionId);
      if (execution?.finished) return execution;
      if (Date.now() > deadline) {
        throw new Error(
          `execution ${executionId} did not finish within ${timeoutMs}ms ` +
            `(last status: ${execution?.status ?? 'not found'})`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

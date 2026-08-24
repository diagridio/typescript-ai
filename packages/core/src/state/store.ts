// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Reusable Dapr state store client for agent memory persistence.
 *
 * Port of `diagrid/agent/core/state/store.py` in `diagridio/python-ai`: wraps
 * the Dapr state management API with JSON serialization and a lazily created
 * client, so constructing a runner does not require a sidecar to be up.
 */

/**
 * Component name to fall back to when the caller names no store.
 *
 * `kvstore` is what a Catalyst project's managed key/value store is called —
 * `diagrid project create --deploy-managed-kv` provisions exactly that name,
 * and the control plane hard-codes it (`DefaultKVStoreName` in
 * `services/cloudgrid/internal/app/catalyst/dataplane/api.go`). Defaulting to
 * it is what makes the documented quickstart need no configuration.
 *
 * It is deliberately *not* `agent-memory`. That name belongs to the
 * dapr-agents convention, and on Catalyst it only exists in projects created
 * with `--enable-agent-infrastructure` (now `diagrid project update
 * --enable-agent-infrastructure`, since the flag was dropped from `project
 * create` in CLI v1.59.0). Those projects pass `storeName` explicitly.
 */
export const DEFAULT_STORE_NAME = 'kvstore';

/**
 * The slice of `DaprClient` this store depends on.
 *
 * Declaring it structurally (rather than importing the concrete class) keeps
 * unit tests sidecar-free: they inject a fake and assert on the calls.
 */
export interface StateClient {
  state: {
    save(
      storeName: string,
      stateObjects: Array<{ key: string; value: unknown }>
    ): Promise<void>;
    get(storeName: string, key: string): Promise<unknown>;
    delete(storeName: string, key: string): Promise<unknown>;
  };
  stop?(): Promise<void>;
}

export interface DaprStateStoreOptions {
  /** Dapr state store component name. */
  readonly storeName?: string;
  /** Pre-built client. Injected by tests; production leaves it unset. */
  readonly client?: StateClient;
}

/**
 * JSON-serializing wrapper over a Dapr state store component.
 *
 * ```ts
 * import { DaprStateStore } from '@diagrid/agent-core';
 *
 * const store = new DaprStateStore({ storeName: 'kvstore' });
 * await store.save('my-key', { messages: ['hello'] });
 * const data = await store.get<{ messages: string[] }>('my-key');
 * await store.close();
 * ```
 */
export class DaprStateStore {
  readonly storeName: string;
  #client: StateClient | undefined;
  /** True when we created the client and are therefore responsible for it. */
  #ownsClient: boolean;

  constructor(options: DaprStateStoreOptions = {}) {
    this.storeName = options.storeName ?? DEFAULT_STORE_NAME;
    this.#client = options.client;
    this.#ownsClient = options.client === undefined;
  }

  /** Lazily create the `DaprClient`, so construction never touches the network. */
  async #getClient(): Promise<StateClient> {
    if (!this.#client) {
      const { DaprClient } = await import('@dapr/dapr');
      this.#client = new DaprClient() as unknown as StateClient;
    }
    return this.#client;
  }

  /** Persist `value` under `key`, JSON-serialized. */
  async save(key: string, value: unknown): Promise<void> {
    const client = await this.#getClient();
    await client.state.save(this.storeName, [
      { key, value: JSON.stringify(value) },
    ]);
  }

  /**
   * Read `key` and JSON-parse it.
   *
   * Returns `undefined` for a missing key. A key whose stored payload is not
   * valid JSON is a corrupt-state condition, so it throws rather than
   * silently returning `undefined` — that distinction matters when the caller
   * is deciding whether to resume from a checkpoint or start fresh.
   */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const client = await this.#getClient();
    const raw = await client.state.get(this.storeName, key);

    // Dapr returns an empty string (HTTP) or an empty object (gRPC) for a
    // key that does not exist.
    if (raw === undefined || raw === null || raw === '') {
      return undefined;
    }
    if (typeof raw !== 'string') {
      return raw as T;
    }

    try {
      return JSON.parse(raw) as T;
    } catch (cause) {
      throw new Error(
        `State key "${key}" in store "${this.storeName}" does not contain valid JSON`,
        { cause }
      );
    }
  }

  /** Remove `key` from the store. */
  async delete(key: string): Promise<void> {
    const client = await this.#getClient();
    await client.state.delete(this.storeName, key);
  }

  /** Release the underlying client, if this store created it. */
  async close(): Promise<void> {
    if (this.#ownsClient && this.#client?.stop) {
      await this.#client.stop();
    }
    if (this.#ownsClient) {
      this.#client = undefined;
    }
  }
}

// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Dapr pub/sub publisher for agent lifecycle events.
 *
 * Port of `diagrid/agent/core/pubsub/pubsub.py` in `diagridio/python-ai`. The
 * adapters publish agent registration and turn-completion events so an
 * orchestrator (or Catalyst) can observe a fleet of agents without polling
 * the workflow API.
 */

export const DEFAULT_PUBSUB_NAME = 'agent-pubsub';

/** The slice of `DaprClient` this publisher depends on. */
export interface PubSubClient {
  pubsub: {
    publish(pubsubName: string, topic: string, data: unknown): Promise<unknown>;
  };
  stop?(): Promise<void>;
}

export interface DaprPubSubOptions {
  /** Dapr pub/sub component name. */
  readonly pubsubName?: string;
  /** Pre-built client. Injected by tests; production leaves it unset. */
  readonly client?: PubSubClient;
}

export class DaprPubSub {
  readonly pubsubName: string;
  #client: PubSubClient | undefined;
  #ownsClient: boolean;

  constructor(options: DaprPubSubOptions = {}) {
    this.pubsubName = options.pubsubName ?? DEFAULT_PUBSUB_NAME;
    this.#client = options.client;
    this.#ownsClient = options.client === undefined;
  }

  async #getClient(): Promise<PubSubClient> {
    if (!this.#client) {
      const { DaprClient } = await import('@dapr/dapr');
      this.#client = new DaprClient();
    }
    return this.#client;
  }

  /** Publish `data` to `topic`. */
  async publish(topic: string, data: unknown): Promise<void> {
    const client = await this.#getClient();
    await client.pubsub.publish(this.pubsubName, topic, data);
  }

  /** Release the underlying client, if this publisher created it. */
  async close(): Promise<void> {
    if (this.#ownsClient && this.#client?.stop) {
      await this.#client.stop();
    }
    if (this.#ownsClient) {
      this.#client = undefined;
    }
  }
}

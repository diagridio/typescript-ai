// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';

import { DaprPubSub, DEFAULT_PUBSUB_NAME } from '@diagrid/agent-core';
import type { PubSubClient } from '@diagrid/agent-core';

interface PublishCall {
  readonly pubsubName: string;
  readonly topic: string;
  readonly data: unknown;
}

function fakePubSubClient(): PubSubClient & {
  readonly calls: PublishCall[];
  readonly stopped: () => boolean;
} {
  const calls: PublishCall[] = [];
  let stopped = false;

  return {
    calls,
    stopped: () => stopped,
    pubsub: {
      publish: (pubsubName, topic, data) => {
        calls.push({ pubsubName, topic, data });
        return Promise.resolve(undefined);
      },
    },
    stop: () => {
      stopped = true;
      return Promise.resolve();
    },
  };
}

describe('DaprPubSub', () => {
  it('defaults to the managed pubsub component', () => {
    expect(DEFAULT_PUBSUB_NAME).toBe('pubsub');
    expect(new DaprPubSub().pubsubName).toBe(DEFAULT_PUBSUB_NAME);
    expect(new DaprPubSub({ pubsubName: 'custom' }).pubsubName).toBe('custom');
  });

  it('publishes to the configured component and topic', async () => {
    const client = fakePubSubClient();
    const pubsub = new DaprPubSub({ pubsubName: 'agent-events', client });

    await pubsub.publish('agent.registered', { name: 'support-agent' });

    expect(client.calls).toEqual([
      {
        pubsubName: 'agent-events',
        topic: 'agent.registered',
        data: { name: 'support-agent' },
      },
    ]);
  });

  it('propagates a publish failure rather than swallowing it', async () => {
    const pubsub = new DaprPubSub({
      client: {
        pubsub: { publish: () => Promise.reject(new Error('broker down')) },
      },
    });

    await expect(pubsub.publish('t', {})).rejects.toThrow('broker down');
  });

  it('does not stop a client it did not create', async () => {
    const client = fakePubSubClient();
    const pubsub = new DaprPubSub({ client });

    await pubsub.close();

    // The caller owns an injected client's lifetime — a runner sharing one
    // client across the state store and the publisher must not have it closed
    // out from under it by whichever closes first.
    expect(client.stopped()).toBe(false);
  });
});

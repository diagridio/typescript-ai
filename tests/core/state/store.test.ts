// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';

import { DaprStateStore, DEFAULT_STORE_NAME } from '@diagrid/agent-core';

import { fakeStateClient } from '../../fixtures/mastra-agent';

describe('DaprStateStore', () => {
  // Pinned to the literal, not just to the constant: the default has to be the
  // name Catalyst actually provisions for `--deploy-managed-kv`, or the
  // quickstart every README recommends points at a component that is not there.
  it('defaults to the managed kvstore component', () => {
    expect(DEFAULT_STORE_NAME).toBe('kvstore');
    expect(new DaprStateStore().storeName).toBe(DEFAULT_STORE_NAME);
  });

  it('round-trips a value through JSON serialization', async () => {
    const client = fakeStateClient();
    const store = new DaprStateStore({ client });

    await store.save('k', { messages: ['hello'], nested: { n: 1 } });

    // The wire format is a JSON string, not the object — that is what Dapr
    // persists, and what a Python adapter reading the same key will parse.
    expect(client.store.get('k')).toBe(
      '{"messages":["hello"],"nested":{"n":1}}'
    );
    await expect(store.get('k')).resolves.toEqual({
      messages: ['hello'],
      nested: { n: 1 },
    });
  });

  it('returns undefined for a missing key', async () => {
    const store = new DaprStateStore({ client: fakeStateClient() });
    await expect(store.get('nope')).resolves.toBeUndefined();
  });

  it('deletes a key', async () => {
    const client = fakeStateClient();
    const store = new DaprStateStore({ client });

    await store.save('k', 1);
    await store.delete('k');

    expect(client.store.has('k')).toBe(false);
  });

  it('throws on corrupt state rather than reporting it as absent', async () => {
    const client = fakeStateClient();
    client.store.set('k', '{not json');
    const store = new DaprStateStore({ client });

    // The distinction matters: "absent" means start a fresh conversation,
    // "corrupt" means something is wrong and silently starting over would
    // discard a user's thread.
    await expect(store.get('k')).rejects.toThrow(/does not contain valid JSON/);
  });

  it('does not stop a client it did not create', async () => {
    const client = fakeStateClient();
    const store = new DaprStateStore({ client });

    await store.close();

    expect(client.stopped).toBe(false);
  });
});

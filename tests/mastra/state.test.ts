// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it } from 'vitest';

import { DaprStateStore } from '@diagrid/agent-core';
import { DaprMastraCheckpointer, type Message } from '@diagrid/agent-mastra';

import { fakeStateClient } from '../fixtures/mastra-agent';

const MESSAGES: Message[] = [
  { role: 'user', content: 'Why was I charged twice?' },
  { role: 'assistant', content: 'Let me check that for you.' },
];

describe('DaprMastraCheckpointer', () => {
  let client: ReturnType<typeof fakeStateClient>;
  let checkpointer: DaprMastraCheckpointer;

  beforeEach(() => {
    client = fakeStateClient();
    checkpointer = new DaprMastraCheckpointer({
      stateStore: new DaprStateStore({ client }),
    });
  });

  it('uses the key layout shared with the Python adapters', () => {
    // Cross-language contract: a Python and a TypeScript adapter pointed at
    // the same state store must not collide, and must be able to read each
    // other's threads.
    expect(DaprMastraCheckpointer.checkpointKey('t1', 'cp-1')).toBe(
      'mastra-t1-checkpoint-cp-1'
    );
    expect(DaprMastraCheckpointer.threadIndexKey('t1')).toBe('mastra-t1-index');
  });

  it('saves a checkpoint and reads it back by id', async () => {
    await checkpointer.save({
      threadId: 't1',
      checkpointId: 'cp-1',
      messages: MESSAGES,
      iteration: 2,
      metadata: { source: 'test' },
    });

    const loaded = await checkpointer.load('t1', 'cp-1');

    expect(loaded).toEqual({
      threadId: 't1',
      checkpointId: 'cp-1',
      messages: MESSAGES,
      iteration: 2,
      metadata: { source: 'test' },
    });
  });

  it('loads the latest checkpoint when no id is given', async () => {
    await checkpointer.save({
      threadId: 't1',
      checkpointId: 'cp-1',
      messages: MESSAGES,
    });
    await checkpointer.save({
      threadId: 't1',
      checkpointId: 'cp-2',
      messages: [...MESSAGES, { role: 'user', content: 'still there?' }],
    });

    const loaded = await checkpointer.load('t1');

    expect(loaded?.checkpointId).toBe('cp-2');
    expect(loaded?.messages).toHaveLength(3);
  });

  it('returns undefined for an unknown thread', async () => {
    await expect(checkpointer.load('nope')).resolves.toBeUndefined();
  });

  it('returns undefined for a thread whose checkpoint is missing', async () => {
    await expect(checkpointer.load('t1', 'cp-404')).resolves.toBeUndefined();
  });

  it('lists checkpoints in save order without duplicating re-saves', async () => {
    await checkpointer.save({
      threadId: 't1',
      checkpointId: 'cp-1',
      messages: [],
    });
    await checkpointer.save({
      threadId: 't1',
      checkpointId: 'cp-2',
      messages: [],
    });
    await checkpointer.save({
      threadId: 't1',
      checkpointId: 'cp-1',
      messages: [],
    });

    await expect(checkpointer.list('t1')).resolves.toEqual(['cp-1', 'cp-2']);
  });

  it('repairs the index when the latest checkpoint is deleted', async () => {
    await checkpointer.save({
      threadId: 't1',
      checkpointId: 'cp-1',
      messages: [],
    });
    await checkpointer.save({
      threadId: 't1',
      checkpointId: 'cp-2',
      messages: [],
    });

    await checkpointer.delete('t1', 'cp-2');

    await expect(checkpointer.list('t1')).resolves.toEqual(['cp-1']);
    expect((await checkpointer.load('t1'))?.checkpointId).toBe('cp-1');
  });

  it('leaves no latest checkpoint once the last one is deleted', async () => {
    await checkpointer.save({
      threadId: 't1',
      checkpointId: 'cp-1',
      messages: [],
    });
    await checkpointer.delete('t1', 'cp-1');

    await expect(checkpointer.list('t1')).resolves.toEqual([]);
    await expect(checkpointer.load('t1')).resolves.toBeUndefined();
  });

  it('ignores deletion of a checkpoint that was never recorded', async () => {
    await expect(checkpointer.delete('t1', 'cp-404')).resolves.toBeUndefined();
  });

  it('rejects a stored payload that does not match the schema', async () => {
    // Someone (or some older version) wrote an incompatible shape. Failing the
    // parse is what stops a corrupt transcript being replayed into a model.
    client.store.set(
      DaprMastraCheckpointer.checkpointKey('t1', 'cp-1'),
      JSON.stringify({ threadId: 't1', checkpointId: 'cp-1', messages: 'nope' })
    );

    await expect(checkpointer.load('t1', 'cp-1')).rejects.toThrow();
  });

  it('defaults to the shared agent-memory store', () => {
    expect(new DaprMastraCheckpointer().storeName).toBe('agent-memory');
    expect(new DaprMastraCheckpointer({ storeName: 'custom' }).storeName).toBe(
      'custom'
    );
  });
});

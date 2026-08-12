// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Shared fixtures: fake Mastra agents and a fake Dapr state client.
 *
 * The mapper reads a Mastra `Agent` structurally (see the note in
 * `packages/mastra/src/mapper.ts` about `@mastra/core` being a peer
 * dependency), so the fixtures below are plain objects shaped like one. That
 * is deliberate, not a shortcut: constructing a real `Agent` would import
 * Mastra into the unit suite and mask the very coupling the guard tests exist
 * to prevent.
 */

import { z } from 'zod';

import type { MastraAgentLike } from '@diagrid/agent-mastra';
import type { StateClient } from '@diagrid/agent-core';

/** An AI SDK model object as Mastra receives it from `openai('gpt-4o-mini')`. */
export function fakeModel(
  overrides: Partial<{
    modelId: string;
    provider: string;
    baseURL: string;
  }> = {}
) {
  return {
    specificationVersion: 'v2',
    modelId: overrides.modelId ?? 'gpt-4o-mini',
    provider: overrides.provider ?? '@ai-sdk/openai',
    ...(overrides.baseURL === undefined ? {} : { baseURL: overrides.baseURL }),
  };
}

/** A Mastra-shaped tool with a Zod input schema. */
export function fakeTool(id: string, description = `The ${id} tool`) {
  return {
    id,
    description,
    inputSchema: z.object({
      query: z.string(),
      limit: z.number().int().optional(),
    }),
  };
}

/** A Mastra-shaped agent, with sensible defaults for every field. */
export function fakeMastraAgent(
  overrides: Partial<MastraAgentLike> = {}
): MastraAgentLike {
  return {
    name: 'support-agent',
    instructions: 'You help customers with billing questions.',
    model: fakeModel(),
    tools: { searchDocs: fakeTool('searchDocs') },
    ...overrides,
  };
}

/**
 * In-memory stand-in for the slice of `DaprClient` the state store uses.
 *
 * Stores exactly what `DaprStateStore` hands it (JSON strings), so a test that
 * round-trips through this fake exercises the real serialization path.
 */
export function fakeStateClient(): StateClient & {
  readonly store: Map<string, string>;
  stopped: boolean;
} {
  const store = new Map<string, string>();
  let stopped = false;

  return {
    store,
    get stopped() {
      return stopped;
    },
    set stopped(value: boolean) {
      stopped = value;
    },
    state: {
      save: (_storeName, stateObjects) => {
        for (const { key, value } of stateObjects) {
          store.set(key, String(value));
        }
        return Promise.resolve();
      },
      get: (_storeName, key) => Promise.resolve(store.get(key) ?? ''),
      delete: (_storeName, key) => {
        store.delete(key);
        return Promise.resolve();
      },
    },
    stop: () => {
      stopped = true;
      return Promise.resolve();
    },
  };
}

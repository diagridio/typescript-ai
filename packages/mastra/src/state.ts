// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Checkpoint persistence for Mastra agent threads.
 *
 * All of the behaviour lives in `@diagrid/agent-core`'s `DaprAgentCheckpointer`:
 * the key layout is a cross-language contract shared with `python-ai`, so it has
 * exactly one definition rather than one per adapter. What is Mastra-specific is
 * the single token those keys are namespaced by.
 *
 * ```text
 * mastra-<threadId>-checkpoint-<checkpointId>   the checkpoint payload
 * mastra-<threadId>-index                       the thread's checkpoint index
 * ```
 */

import {
  DaprAgentCheckpointer,
  checkpointKey,
  threadIndexKey,
  type DaprAgentCheckpointerOptions,
} from '@diagrid/agent-core';

/** The token every Mastra checkpoint key is namespaced by. */
export const MASTRA_KEY_PREFIX = 'mastra';

export type DaprMastraCheckpointerOptions = Omit<
  DaprAgentCheckpointerOptions,
  'keyPrefix'
>;

export class DaprMastraCheckpointer extends DaprAgentCheckpointer {
  constructor(options: DaprMastraCheckpointerOptions = {}) {
    super({ ...options, keyPrefix: MASTRA_KEY_PREFIX });
  }

  /**
   * Key helpers, kept static.
   *
   * They were static before the move and are used that way, so the shape is
   * preserved. Both delegate to core's single definition of the layout.
   */
  static checkpointKey(threadId: string, checkpointId: string): string {
    return checkpointKey(MASTRA_KEY_PREFIX, threadId, checkpointId);
  }

  static threadIndexKey(threadId: string): string {
    return threadIndexKey(MASTRA_KEY_PREFIX, threadId);
  }
}

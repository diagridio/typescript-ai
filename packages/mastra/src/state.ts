// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Dapr-backed checkpoint persistence for Mastra agent threads.
 *
 * Mirrors `diagrid/agent/langgraph/state.py` in `diagridio/python-ai`,
 * including the key layout, so the same state store can hold checkpoints
 * written by adapters in either language without collisions:
 *
 * ```text
 * mastra-<threadId>-checkpoint-<checkpointId>   the checkpoint payload
 * mastra-<threadId>-index                       the thread's checkpoint index
 * ```
 *
 * Dapr already persists workflow history, so this is not what makes the agent
 * crash-proof. It is the conversation-memory layer: it lets a *new* workflow
 * pick up a thread the previous one finished, which workflow history alone
 * does not give you.
 */

import { DaprStateStore } from '@diagrid/agent-core';

import {
  checkpointIndexSchema,
  checkpointSchema,
  type Checkpoint,
  type CheckpointIndex,
  type Message,
} from './models';

const KEY_PREFIX = 'mastra';

export interface DaprMastraCheckpointerOptions {
  /** Dapr state store component name. */
  readonly storeName?: string;
  /** Pre-built store. Injected by tests; production leaves it unset. */
  readonly stateStore?: DaprStateStore;
}

export interface SaveCheckpointArgs {
  readonly threadId: string;
  readonly checkpointId: string;
  readonly messages: readonly Message[];
  readonly iteration?: number;
  readonly metadata?: Record<string, unknown>;
}

export class DaprMastraCheckpointer {
  readonly #store: DaprStateStore;

  constructor(options: DaprMastraCheckpointerOptions = {}) {
    this.#store =
      options.stateStore ??
      new DaprStateStore(
        options.storeName === undefined ? {} : { storeName: options.storeName }
      );
  }

  get storeName(): string {
    return this.#store.storeName;
  }

  static checkpointKey(threadId: string, checkpointId: string): string {
    return `${KEY_PREFIX}-${threadId}-checkpoint-${checkpointId}`;
  }

  static threadIndexKey(threadId: string): string {
    return `${KEY_PREFIX}-${threadId}-index`;
  }

  /** Persist a checkpoint and record it as the thread's latest. */
  async save(args: SaveCheckpointArgs): Promise<Checkpoint> {
    const checkpoint = checkpointSchema.parse({
      threadId: args.threadId,
      checkpointId: args.checkpointId,
      messages: args.messages,
      iteration: args.iteration ?? 0,
      metadata: args.metadata ?? {},
    });

    await this.#store.save(
      DaprMastraCheckpointer.checkpointKey(args.threadId, args.checkpointId),
      checkpoint
    );

    // Read-modify-write on the index. Single-writer per thread is the design
    // assumption (Dapr serializes a workflow instance's activities), so no
    // etag/transaction is used here.
    // TODO(mastra-adapter): revisit once fan-out sub-agents can write
    // checkpoints for the same thread concurrently — that breaks the
    // single-writer assumption and will need an etag-guarded update.
    const index = await this.loadIndex(args.threadId);
    const checkpoints = index.checkpoints.includes(args.checkpointId)
      ? index.checkpoints
      : [...index.checkpoints, args.checkpointId];

    await this.#store.save(
      DaprMastraCheckpointer.threadIndexKey(args.threadId),
      checkpointIndexSchema.parse({
        checkpoints,
        latest: args.checkpointId,
      })
    );

    return checkpoint;
  }

  /**
   * Load a checkpoint. With no `checkpointId`, loads the thread's latest.
   *
   * Returns `undefined` when the thread (or the requested checkpoint) has no
   * stored state — the caller's cue to start the conversation fresh.
   */
  async load(
    threadId: string,
    checkpointId?: string
  ): Promise<Checkpoint | undefined> {
    let id = checkpointId;
    if (id === undefined) {
      const index = await this.loadIndex(threadId);
      if (!index.latest) {
        return undefined;
      }
      id = index.latest;
    }

    const raw = await this.#store.get(
      DaprMastraCheckpointer.checkpointKey(threadId, id)
    );
    if (raw === undefined) {
      return undefined;
    }
    return checkpointSchema.parse(raw);
  }

  /** List every checkpoint id recorded for a thread, oldest first. */
  async list(threadId: string): Promise<string[]> {
    return [...(await this.loadIndex(threadId)).checkpoints];
  }

  /** Delete one checkpoint and repair the thread index. */
  async delete(threadId: string, checkpointId: string): Promise<void> {
    await this.#store.delete(
      DaprMastraCheckpointer.checkpointKey(threadId, checkpointId)
    );

    const index = await this.loadIndex(threadId);
    if (!index.checkpoints.includes(checkpointId)) {
      return;
    }

    const checkpoints = index.checkpoints.filter((id) => id !== checkpointId);
    const latest =
      index.latest === checkpointId
        ? (checkpoints.at(-1) ?? null)
        : index.latest;

    await this.#store.save(
      DaprMastraCheckpointer.threadIndexKey(threadId),
      checkpointIndexSchema.parse({ checkpoints, latest })
    );
  }

  /** Release the underlying state store. */
  async close(): Promise<void> {
    await this.#store.close();
  }

  private async loadIndex(threadId: string): Promise<CheckpointIndex> {
    const raw = await this.#store.get(
      DaprMastraCheckpointer.threadIndexKey(threadId)
    );
    if (raw === undefined) {
      return checkpointIndexSchema.parse({});
    }
    return checkpointIndexSchema.parse(raw);
  }
}

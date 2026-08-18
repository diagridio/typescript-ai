// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Dapr-backed checkpoint persistence for agent threads.
 *
 * Framework-agnostic and therefore in `core`: the key layout is a
 * *cross-language* contract, and duplicating it per adapter is how two adapters
 * end up disagreeing about where a thread's checkpoints live.
 *
 * Mirrors `diagrid/agent/langgraph/state.py` in `diagridio/python-ai`,
 * including the key layout, so the same state store can hold checkpoints
 * written by adapters in either language without collisions:
 *
 * ```text
 * <prefix>-<threadId>-checkpoint-<checkpointId>   the checkpoint payload
 * <prefix>-<threadId>-index                       the thread's checkpoint index
 * ```
 *
 * `<prefix>` is the framework token — `mastra`, `langgraph` — supplied by the
 * adapter. It is the only framework-specific thing in this file.
 *
 * Dapr already persists workflow history, so this is not what makes the agent
 * crash-proof. It is the conversation-memory layer: it lets a *new* workflow
 * pick up a thread the previous one finished, which workflow history alone
 * does not give you.
 */

import {
  checkpointIndexSchema,
  checkpointSchema,
  type Checkpoint,
  type CheckpointIndex,
  type Message,
} from '../agent/models';
import { DaprStateStore } from './store';

export interface DaprAgentCheckpointerOptions {
  /**
   * Framework token used to namespace every key, e.g. `mastra`.
   *
   * Required rather than defaulted: a plausible-but-wrong default would put one
   * adapter's checkpoints in another's keyspace, and the symptom would be an
   * agent reading a different agent's conversation.
   */
  readonly keyPrefix: string;
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

export class DaprAgentCheckpointer {
  readonly #store: DaprStateStore;
  readonly #keyPrefix: string;

  constructor(options: DaprAgentCheckpointerOptions) {
    this.#keyPrefix = options.keyPrefix;
    this.#store =
      options.stateStore ??
      new DaprStateStore(
        options.storeName === undefined ? {} : { storeName: options.storeName }
      );
  }

  get storeName(): string {
    return this.#store.storeName;
  }

  checkpointKey(threadId: string, checkpointId: string): string {
    return checkpointKey(this.#keyPrefix, threadId, checkpointId);
  }

  threadIndexKey(threadId: string): string {
    return threadIndexKey(this.#keyPrefix, threadId);
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
      this.checkpointKey(args.threadId, args.checkpointId),
      checkpoint
    );

    // Read-modify-write on the index. Single-writer per thread is the design
    // assumption (Dapr serializes a workflow instance's activities), so no
    // etag/transaction is used here.
    // TODO(agent-core): revisit once fan-out sub-agents can write
    // checkpoints for the same thread concurrently — that breaks the
    // single-writer assumption and will need an etag-guarded update.
    const index = await this.loadIndex(args.threadId);
    const checkpoints = index.checkpoints.includes(args.checkpointId)
      ? index.checkpoints
      : [...index.checkpoints, args.checkpointId];

    await this.#store.save(
      this.threadIndexKey(args.threadId),
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

    const raw = await this.#store.get(this.checkpointKey(threadId, id));
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
    await this.#store.delete(this.checkpointKey(threadId, checkpointId));

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
      this.threadIndexKey(threadId),
      checkpointIndexSchema.parse({ checkpoints, latest })
    );
  }

  /** Release the underlying state store. */
  async close(): Promise<void> {
    await this.#store.close();
  }

  private async loadIndex(threadId: string): Promise<CheckpointIndex> {
    const raw = await this.#store.get(this.threadIndexKey(threadId));
    if (raw === undefined) {
      return checkpointIndexSchema.parse({});
    }
    return checkpointIndexSchema.parse(raw);
  }
}

/**
 * Key layout, as free functions.
 *
 * Exported so an adapter can offer a static helper without re-deriving the
 * format — there is exactly one definition of the cross-language key shape.
 */
export function checkpointKey(
  keyPrefix: string,
  threadId: string,
  checkpointId: string
): string {
  return `${keyPrefix}-${threadId}-checkpoint-${checkpointId}`;
}

export function threadIndexKey(keyPrefix: string, threadId: string): string {
  return `${keyPrefix}-${threadId}-index`;
}

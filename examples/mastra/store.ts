// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * State store selection shared by the examples.
 *
 * The component name differs between the two run paths, which is the one place
 * the same code cannot be used unchanged:
 *
 * - **Local Dapr** — `./resources/statestore.yaml` declares `agent-memory`, which
 *   is `DEFAULT_STORE_NAME` in `@diagrid/agent-core`, so nothing needs setting.
 * - **Diagrid Catalyst** — the project's managed KV store has its own name (run
 *   `diagrid connection list` to see it). Set `DIAGRID_STATE_STORE` to it.
 *
 * Reading it from the environment keeps both paths code-edit-free.
 */

import { DaprStateStore, DEFAULT_STORE_NAME } from '@diagrid/agent-core';

/** The component name in use, from `DIAGRID_STATE_STORE` or the shared default. */
export function resolveStoreName(): string {
  return process.env['DIAGRID_STATE_STORE'] ?? DEFAULT_STORE_NAME;
}

/** A state store pointed at whichever component this run path provides. */
export function resolveStateStore(): DaprStateStore {
  return new DaprStateStore({ storeName: resolveStoreName() });
}

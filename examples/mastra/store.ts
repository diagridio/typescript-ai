// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * State store selection shared by the examples.
 *
 * Both run paths use the same component name, so neither needs configuring:
 *
 * - **Local Dapr** — `./resources/statestore.yaml` declares `kvstore`.
 * - **Diagrid Catalyst** — `--deploy-managed-kv` provisions a managed KV store
 *   component, and it is always called `kvstore`.
 *
 * That name is `DEFAULT_STORE_NAME` in `@diagrid/agent-core`. Reading an
 * override from the environment is still worth it for the projects where the
 * name genuinely differs — a project created with `--enable-agent-infrastructure`
 * has `agent-memory` instead, and a bring-your-own state component can be
 * called anything. `DIAGRID_STATE_STORE` covers both without a code edit.
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

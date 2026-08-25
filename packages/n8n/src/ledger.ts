// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Idempotency ledger for node activity results, backed by
 * `@diagrid/agent-core`'s `DaprStateStore` — reused rather than the original
 * draft's own raw `DaprClient` usage. Three real gains from the switch:
 * lazy client construction (matches this package's own existing "don't touch
 * `@dapr/dapr` until actually needed" discipline, now shared with core rather
 * than duplicated), JSON serialization handled once and consistently, and a
 * real `close()` this package's own shutdown sequence can call (see
 * runtime.ts) — the original draft's `ledger.ts` had no equivalent and never
 * released its `DaprClient` connection on shutdown.
 *
 * `DaprStateStore`'s own default component name is `kvstore`, not
 * `statestore` (the original draft's default) — deliberately adopted as-is
 * here rather than overridden: `kvstore` is the real, live Catalyst-managed
 * component name (`DefaultKVStoreName` in the control plane — confirmed in
 * `packages/core/src/state/store.ts`'s own doc comment and in
 * `examples/mastra/resources/statestore.yaml`), so keeping the same default
 * means an n8n deployment on Catalyst needs no configuration at all. Still
 * overridable via `DIAGRID_N8N_STATE_STORE` for local setups that want a
 * different component name.
 */

import { DaprStateStore } from '@diagrid/agent-core';

import { runNodeOutputSchema } from './schemas';
import type { RunNodeOutput } from './types';

let store: DaprStateStore | undefined;

function getStore(): DaprStateStore {
  // `exactOptionalPropertyTypes` rejects `storeName: undefined` against a
  // field typed `storeName?: string` (no explicit `| undefined`) — only
  // include the key when an override is actually set, so an unset env var
  // falls through to `DaprStateStore`'s own `DEFAULT_STORE_NAME` ('kvstore').
  const override = process.env['DIAGRID_N8N_STATE_STORE'];
  store ??= new DaprStateStore(
    override !== undefined ? { storeName: override } : {}
  );
  return store;
}

function ledgerKey(
  instanceId: string,
  nodeName: string,
  runIndex: number,
  attempt: number
): string {
  return `diagrid.n8n:${instanceId}:${nodeName}:${runIndex}:${attempt}`;
}

/**
 * Idempotency ledger for node activity results, keyed by attempt as well as
 * by node/run, deliberately: redelivery of the *same* attempt must be
 * deduped, but a genuinely new attempt after a real failure and a backoff
 * wait should still get to actually retry.
 *
 * Zod-parsed on the way out — this repo's own "Zod at boundaries" convention
 * (`AGENTS.md`): a value returned here was written by a *previous* activity
 * invocation, possibly in a different process, and is read back from storage
 * exactly like the case that convention targets. `.parse()` throws on a
 * genuinely corrupt or differently-shaped entry rather than returning a
 * silently-wrong value the caller would trust as a real completed result.
 */
export async function readLedger(
  instanceId: string,
  nodeName: string,
  runIndex: number,
  attempt: number
): Promise<RunNodeOutput | undefined> {
  const raw = await getStore().get<unknown>(
    ledgerKey(instanceId, nodeName, runIndex, attempt)
  );
  if (raw === undefined) return undefined;
  // Validated at the boundary above; the cast narrows the Zod-inferred shape
  // (which uses `.passthrough()`/`unknown` for n8n-owned fields — see
  // schemas.ts's own doc comment on why) back to the richer real type the
  // rest of this package works with.
  return runNodeOutputSchema.parse(raw) as RunNodeOutput;
}

export async function writeLedger(
  instanceId: string,
  nodeName: string,
  runIndex: number,
  attempt: number,
  value: RunNodeOutput
): Promise<void> {
  await getStore().save(
    ledgerKey(instanceId, nodeName, runIndex, attempt),
    value
  );
}

/** For runtime.ts's shutdown sequence — see this file's own doc comment. */
export async function closeLedgerStore(): Promise<void> {
  await store?.close();
  store = undefined;
}

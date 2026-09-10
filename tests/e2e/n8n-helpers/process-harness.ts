// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Shared process/availability/polling machinery for the n8n integration
 * tests — extracted out of `n8n-crash-recovery.integration.test.ts` once a
 * second scenario (`n8n-crash-recovery-subworkflow.integration.test.ts`)
 * needed the exact same building blocks. See either test file's own
 * top-of-file comment for why this suite needs its own detection/skip logic,
 * unlike the mastra integration tests.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
export const PACKAGES_N8N_DIR = join(REPO_ROOT, 'packages', 'n8n');
export const PRELOAD_CJS = join(PACKAGES_N8N_DIR, 'dist', 'preload.cjs');
export const BYPASS_SHIM = join(
  REPO_ROOT,
  'tests',
  'e2e',
  'n8n-helpers',
  'node-version-bypass.cjs'
);
export const RESOURCES_DIR = join(REPO_ROOT, 'examples', 'n8n', 'resources');

/** Same probe `mastra-examples.integration.test.ts` uses: is the CLI itself usable? */
export const HAS_DAPR = (() => {
  try {
    execFileSync('dapr', ['--version'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Is a `dapr_redis` container reachable via `docker exec`? Only the
 * sub-workflow scenario needs this (a direct scan of the workflow engine's
 * own backing store, proving no duplicate child instance was created —
 * the one thing an HTTP state read cannot show, since it can only fetch a
 * key you already know the name of, not enumerate unknown ones). Named
 * `dapr_redis` is what `dapr init`'s default self-hosted setup provisions;
 * this genuinely does not generalize to every possible state store, which is
 * exactly why it is its own gate rather than folded into `HAS_DAPR`.
 */
export const HAS_DOCKER_REDIS = (() => {
  try {
    execFileSync('docker', ['exec', 'dapr_redis', 'redis-cli', 'PING'], {
      stdio: 'ignore',
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
})();

export interface N8nCheckout {
  readonly root: string;
  readonly n8nBin: string;
}

/**
 * Resolves `scripts/link-n8n-dev-deps.sh`'s own symlink back to a real n8n
 * checkout root, rather than requiring a separate, new env var. Returns
 * `undefined` for any reason the checkout isn't usable — not found, not a
 * real symlink, or present but never built.
 */
export function resolveN8nCheckout(): N8nCheckout | undefined {
  const n8nCoreLink = join(PACKAGES_N8N_DIR, 'node_modules', 'n8n-core');
  if (!existsSync(n8nCoreLink)) return undefined;

  let resolvedCore: string;
  try {
    resolvedCore = realpathSync(n8nCoreLink);
  } catch {
    return undefined;
  }

  // resolvedCore is <checkout>/packages/core
  const root = dirname(dirname(resolvedCore));
  const n8nBin = join(root, 'packages', 'cli', 'bin', 'n8n');
  const cliDist = join(root, 'packages', 'cli', 'dist');
  if (!existsSync(n8nBin) || !existsSync(cliDist)) return undefined;

  return { root, n8nBin };
}

export const PRELOAD_BUILT = existsSync(PRELOAD_CJS);
export const N8N_CHECKOUT = resolveN8nCheckout();

export function readTextSafe(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/**
 * Poll a growing log file for a line, rather than sleeping a fixed duration
 * — the DEMO.md-proven fix for a flaky fixed sleep-then-kill (see either
 * test file's own top comment).
 */
export async function waitForLogLine(
  logPath: string,
  pattern: string,
  timeoutMs: number,
  intervalMs = 50
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = readTextSafe(logPath);
    if (content.includes(pattern)) return content;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${logPath} to contain ${JSON.stringify(pattern)}. ` +
          `Last 2000 chars:\n${content.slice(-2000)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Same as {@link waitForLogLine}, but returns the first regex match (with capture groups) rather than the whole file. */
export async function waitForLogMatch(
  logPath: string,
  pattern: RegExp,
  timeoutMs: number,
  intervalMs = 50
): Promise<RegExpMatchArray> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = readTextSafe(logPath).match(pattern);
    if (match) return match;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${logPath} to match ${pattern}. ` +
          `Last 2000 chars:\n${readTextSafe(logPath).slice(-2000)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Bounded polling for an async condition — never a single check-and-hope. */
export async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 1_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export interface MarkerEntry {
  readonly nodeName: string;
  readonly attempt: number;
  readonly instanceId: string;
  readonly pid: number;
  readonly status: string;
}

export function readMarkerLog(path: string): MarkerEntry[] {
  return readTextSafe(path)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MarkerEntry);
}

/**
 * Existence check via Dapr's own HTTP state API — bypasses this package's
 * code entirely.
 *
 * `res.ok` alone is not existence: confirmed directly during this suite's own
 * development (it returned `true` for a key that provably did not exist yet)
 * — Dapr's HTTP state GET returns 200 with an EMPTY body for a missing key,
 * not 404. Same behavior `@diagrid/agent-core`'s own `DaprStateStore.get()`
 * doc comment already documents.
 */
export async function ledgerKeyExists(
  daprHttpPort: number,
  key: string
): Promise<boolean> {
  const res = await fetch(
    `http://localhost:${daprHttpPort}/v1.0/state/kvstore/${encodeURIComponent(key)}`
  );
  if (!res.ok) return false;
  const text = await res.text();
  return text.length > 0;
}

/**
 * Reads a ledger entry's real value (a `RunNodeOutput` — see
 * packages/n8n/src/types.ts), not just whether it exists.
 *
 * TWO levels of `JSON.parse` beyond {@link ledgerKeyExists}'s own existence
 * check — confirmed directly, not assumed, by fetching a real ledger entry's
 * raw bytes: `ledger.ts`'s `writeLedger` goes through `@diagrid/agent-core`'s
 * `DaprStateStore.save()`, which itself `JSON.stringify`s the value before
 * handing it to the SDK, so the STORED state value is already a JSON
 * string. Dapr's HTTP GET then returns that stored value JSON-encoded AGAIN
 * (the response body is itself a JSON string literal) — the real raw bytes
 * observed for one entry were
 * `"{\"status\":\"success\",\"nodeName\":\"Probe Set\",...}"` (an outer pair
 * of quotes around an escaped inner JSON string, not a bare object). One
 * `JSON.parse` un-escapes the outer layer and yields a plain JS *string*
 * that itself still looks like JSON text; a second `JSON.parse` on that
 * result is what actually yields the real object. `DaprStateStore.get()`'s
 * own doc comment describes the same "read back from storage" shape, but
 * for the single-encoded case its own callers pass through — this ledger
 * key is doubly so, since the stored value was already a JSON string before
 * Dapr's own HTTP layer added its own. Used in preference to reading a
 * node's real output back out of n8n's own execution record: that record's
 * `data` field is a `flatted`-compressed blob whose leaf values are not
 * embedded as plain, greppable substrings (confirmed directly — an earlier
 * version of this file's sub-workflow test tried exactly that and it did
 * not find a value known to be present). The ledger already holds the same
 * real `outputItems` this package produced, without needing to speak
 * `flatted`.
 */
export async function readLedgerValue(
  daprHttpPort: number,
  key: string
): Promise<unknown> {
  const res = await fetch(
    `http://localhost:${daprHttpPort}/v1.0/state/kvstore/${encodeURIComponent(key)}`
  );
  if (!res.ok) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  const onceUnwrapped: unknown = JSON.parse(text);
  return typeof onceUnwrapped === 'string'
    ? (JSON.parse(onceUnwrapped) as unknown)
    : onceUnwrapped;
}

/**
 * Direct Redis inspection of Dapr's OWN workflow-engine backing store (the
 * `workflows-state` component, not the ledger's `kvstore`) — confirmed by
 * actually scanning it during this suite's development. A workflow
 * instance's key shape is
 * `<app-id>||dapr.internal.default.<app-id>.workflow||<instanceId>||<field>`
 * (Dapr's own actor-based key scheme; `workflow` here is the actor type
 * Dapr Workflows registers under). The `metadata` field is written once, at
 * instance-creation time, so its presence is the most direct "does this
 * instance exist yet" signal available — the same class of check the
 * original `n8n-dapr-durable` project's own Phase 3 proof used (a raw redis
 * scan bypassing this package's code and n8n's REST API both), just against
 * this repo's real component name (`workflows-state`'s backing Redis, shared
 * with `kvstore` in local dev — see examples/n8n/resources/statestore.yaml).
 */
export function workflowInstanceExists(
  appId: string,
  instanceId: string
): boolean {
  const key = `${appId}||dapr.internal.default.${appId}.workflow||${instanceId}||metadata`;
  const out = execFileSync(
    'docker',
    ['exec', 'dapr_redis', 'redis-cli', 'EXISTS', key],
    { encoding: 'utf8', timeout: 15_000 }
  );
  return out.trim() === '1';
}

/**
 * Every distinct child instance id Dapr's own backing store knows about for
 * a given parent — the direct proof "no duplicate child was created", not an
 * inference from n8n's own behavior. Matches on the `metadata` key
 * specifically so each real instance is counted once regardless of how many
 * history/customStatus keys it has accumulated.
 */
export function distinctChildInstanceIds(
  appId: string,
  parentInstanceId: string
): string[] {
  const pattern = `${appId}||dapr.internal.default.${appId}.workflow||${parentInstanceId}:*||metadata`;
  const out = execFileSync(
    'docker',
    ['exec', 'dapr_redis', 'redis-cli', '--scan', '--pattern', pattern],
    { encoding: 'utf8', timeout: 15_000 }
  );
  const prefix = `${appId}||dapr.internal.default.${appId}.workflow||`;
  const suffix = '||metadata';
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(prefix.length, line.length - suffix.length));
}

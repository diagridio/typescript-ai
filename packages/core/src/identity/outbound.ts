// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Outbound user-token propagation.
 *
 * The inbound middleware stores the raw token for the duration of the request;
 * outbound MCP / sub-agent calls read it back and set `X-Diagrid-User-Token` on
 * their own request. An app does not read it back by hand: {@link ./fetch}'s
 * `createIdentityFetch` is the advertised outbound path, and this module is what
 * it reads.
 *
 * The token is scoped with a single {@link runWithUserToken} rather than a
 * set / clear pair, so it cannot leak past the request that carried it — there
 * is no "clear" to forget.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** The header dp-Sentry-signed user tokens travel on, inbound and outbound. */
export const USER_TOKEN_HEADER = 'X-Diagrid-User-Token';

/** Scheme prefix on the header value. The trailing space is part of it. */
export const BEARER_PREFIX = 'Bearer ';

const userTokenStorage = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `rawToken` as the ambient user token.
 *
 * The token is visible to everything `fn` starts, across `await` points, and
 * to nothing outside it.
 */
export function runWithUserToken<T>(rawToken: string, fn: () => T): T {
  return userTokenStorage.run(rawToken, fn);
}

/**
 * The raw bearer token for the request in flight.
 *
 * `undefined` outside an authenticated request — a scheduled, pub/sub or cron
 * trigger has no inbound caller to act on behalf of.
 */
export function currentUserToken(): string | undefined {
  return userTokenStorage.getStore();
}

/**
 * The identity headers for the request in flight.
 *
 * Empty when there is no inbound user context, so the header is omitted
 * rather than sent with an empty value.
 *
 * @internal Not part of the package surface. Assembling the header by hand
 * skips both the clear-first rule and the origin guard, so
 * {@link ./fetch}'s `createIdentityFetch` is the advertised outbound path; this
 * is exported only so that sibling can consume it.
 */
export function outboundIdentityHeaders(): Record<string, string> {
  const token = userTokenStorage.getStore();
  if (!token) {
    return {};
  }
  return { [USER_TOKEN_HEADER]: `${BEARER_PREFIX}${token}` };
}

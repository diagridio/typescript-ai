// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Token scoping and the outbound header it produces.
 *
 * The assertion that matters: outside a verified request the header is
 * *absent*, not empty.
 */

import { describe, expect, it } from 'vitest';

import {
  BEARER_PREFIX,
  USER_TOKEN_HEADER,
  currentUserToken,
  runWithUserToken,
} from '@diagrid/agent-core';

// Reached by path, not through the barrel: `outboundIdentityHeaders` is the
// module-internal helper behind `createIdentityFetch`, which is what the
// package advertises instead.
import { outboundIdentityHeaders } from '../../../packages/core/src/identity/outbound';

describe('user token context', () => {
  it('exposes the token inside the scope', () => {
    runWithUserToken('abc123', () => {
      expect(currentUserToken()).toBe('abc123');
    });
  });

  it('has no token outside a scope', () => {
    expect(currentUserToken()).toBeUndefined();
  });

  it('does not leak the token past the scope that carried it', () => {
    runWithUserToken('abc123', () => currentUserToken());

    expect(currentUserToken()).toBeUndefined();
  });

  it('carries the token across await points', async () => {
    const seen = await runWithUserToken('deferred', async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentUserToken();
    });

    expect(seen).toBe('deferred');
  });

  it('keeps concurrent scopes apart', async () => {
    // The property a module-level mutable "current token" would fail: two
    // requests in flight at once must not see each other's caller.
    const [first, second] = await Promise.all([
      runWithUserToken('one', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return currentUserToken();
      }),
      runWithUserToken('two', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return currentUserToken();
      }),
    ]);

    expect([first, second]).toEqual(['one', 'two']);
  });
});

describe('outboundIdentityHeaders', () => {
  it('propagates the inbound token as a bearer header', () => {
    const headers = runWithUserToken('tok', outboundIdentityHeaders);

    expect(headers).toEqual({ 'X-Diagrid-User-Token': 'Bearer tok' });
  });

  it('omits the header entirely when there is no inbound caller', () => {
    // Scheduled, pub/sub and cron triggers land here. An empty header value
    // would look like a malformed token to the receiving side.
    expect(outboundIdentityHeaders()).toEqual({});
  });

  it('builds the header from the exported constants', () => {
    // The header name and scheme prefix are the cross-SDK wire contract.
    expect(USER_TOKEN_HEADER).toBe('X-Diagrid-User-Token');
    expect(BEARER_PREFIX).toBe('Bearer ');
    expect(runWithUserToken('t', outboundIdentityHeaders)).toEqual({
      [USER_TOKEN_HEADER]: `${BEARER_PREFIX}t`,
    });
  });
});

// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The scope predicate that sits next to the verified caller.
 *
 * A free function rather than a method, because `VerifiedUser` is a plain
 * shape: see `packages/core/src/identity/types.ts` for why that matters.
 */

import { describe, expect, it } from 'vitest';

import { hasScope } from '@diagrid/agent-core';
import type { VerifiedUser } from '@diagrid/agent-core';

function userWith(scopes: readonly string[]): VerifiedUser {
  return {
    subject: 'alice@example.com',
    tenant: 'acme',
    scopes,
    claims: { sub: 'alice@example.com' },
    issuerId: 'https://oidc.example.com',
  };
}

describe('hasScope', () => {
  it('answers true for a scope the caller carries', () => {
    expect(
      hasScope(userWith(['agent.invoke', 'agent.read']), 'agent.read')
    ).toBe(true);
  });

  it('answers false for a scope the caller lacks', () => {
    expect(hasScope(userWith(['agent.read']), 'agent.invoke')).toBe(false);
  });

  it('answers false for a caller with no scopes at all', () => {
    expect(hasScope(userWith([]), 'agent.invoke')).toBe(false);
  });

  it('matches exactly, never by prefix', () => {
    // `agent.invoke.admin` is a different grant from `agent.invoke`, and a
    // predicate that conflated them would widen every scope check in the SDK.
    expect(hasScope(userWith(['agent.invoke.admin']), 'agent.invoke')).toBe(
      false
    );
  });
});

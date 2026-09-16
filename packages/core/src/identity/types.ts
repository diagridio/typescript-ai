// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * App-side identity types for Catalyst agents.
 *
 * Scope lists are `readonly string[]` rather than `ReadonlySet`, because a
 * `Set` serialises to `{}` and handing the list to `res.json()` is the
 * commonest thing a handler does with it.
 */

import type { JWTPayload } from 'jose';

/**
 * Decoded JWT payload.
 *
 * Aliased from `jose` so callers can name the type without taking their own
 * dependency on it.
 */
export type TokenClaims = JWTPayload;

/**
 * Policy the middleware enforces on every inbound request.
 *
 * Every field is optional, and the defaults are the safe ones: no required
 * scopes, coordinates discovered from the sidecar, and authentication
 * required.
 */
export interface OAuthConfig {
  /**
   * Required scopes — the middleware answers 403 when the verified token
   * lacks any of them.
   */
  readonly scopes?: readonly string[];
  /**
   * Expected `iss` claim. Normally discovered from the sidecar
   * `/v1.0/metadata` response; set explicitly only when the metadata endpoint
   * is unavailable.
   */
  readonly issuer?: string;
  /** Expected `aud` claim. Same discovery rules as {@link OAuthConfig.issuer}. */
  readonly audience?: string;
  /** JWKS endpoint for signature verification. Same discovery rules. */
  readonly jwksUri?: string;
  /**
   * When `true` (the default), requests without `X-Diagrid-User-Token` are
   * rejected with 401. Set to `false` to let unauthenticated routes (health,
   * readiness) share the same app.
   */
  readonly requireAuth?: boolean;
  /**
   * Permit a resolved JWKS URI that is not `https`.
   *
   * `false` by default, and deliberately: the key set is the entire root of
   * trust, so an on-path attacker who can rewrite a plaintext response can
   * mint credentials this app will accept. A loopback host is exempt without
   * the flag — that is where the local sidecar publishes its keys.
   */
  readonly allowInsecureJwks?: boolean;
}

/**
 * Verified caller identity attached to the request.
 *
 * Read it with `getVerifiedUser(req)`, from `@diagrid/agent-core/express` or
 * `@diagrid/agent-core/fastify`. Never from `req.user`: that name belongs to
 * the application — see `./express.ts` and `./fastify.ts` for why.
 */
export interface VerifiedUser {
  /** `sub` claim — email, user-id, or agent SPIFFE URI. */
  readonly subject: string;
  /** Tenant / org claim extracted from the token. Empty when absent. */
  readonly tenant: string;
  /** OAuth scopes carried by the token. */
  readonly scopes: readonly string[];
  /** Full decoded JWT payload, for policies that need richer access. */
  readonly claims: TokenClaims;
  /** The `iss` value on the verified token. */
  readonly issuerId: string;
}

/**
 * Whether `user` was granted `scope`.
 *
 * A free function rather than a method, because {@link VerifiedUser} is a plain
 * shape: a prototype method would go missing from any one that arrived as data —
 * revived from a workflow payload, a cache or a test fixture.
 *
 * Exact match, never a prefix: `agent.invoke.admin` is a different grant from
 * `agent.invoke`.
 */
export function hasScope(user: VerifiedUser, scope: string): boolean {
  return user.scopes.includes(scope);
}

// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The Fastify plugin, driven through a real app.
 *
 * Two things are checked here that `./express.test.ts` cannot check, because
 * they are Fastify-specific and both have silently broken this shape of
 * plugin before:
 *
 * - The hook applies to routes registered *outside* the plugin. Without the
 *   `fastify-plugin` wrapper, `register` creates an encapsulated child
 *   context, the hook stays inside it, and every route in the app is
 *   unprotected while the plugin appears to install cleanly.
 * - The token scope survives into the handler. Fastify runs an `async`
 *   `onRequest` hook to completion before the handler starts, so a scope
 *   entered inside one would already have closed — which is why the hook is
 *   written in callback form.
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  TokenVerificationError,
  VerifierNotReadyError,
  type TokenClaims,
  type TokenVerifier,
} from '@diagrid/agent-core';

// `outboundIdentityHeaders` is module-internal, so these cases reach it by
// path. What they assert is that the middleware scopes the raw token for the
// duration of the request and nothing outside it can read it back.
import { outboundIdentityHeaders } from '../../../packages/core/src/identity/outbound';
import {
  getVerifiedUser,
  oauthPlugin,
  type OAuthPluginOptions,
} from '@diagrid/agent-core/fastify';

import { epochSeconds } from '../../fixtures/identity';

const USER_TOKEN_HEADER = 'X-Diagrid-User-Token';

const VERIFIED_CLAIMS: TokenClaims = {
  sub: 'alice@example.com',
  tid: 'acme-corp',
  scp: ['agent.invoke', 'admin'],
  iss: 'https://oidc.example.com',
  exp: epochSeconds(3600),
};

function stubVerifier(claims: TokenClaims, failure?: Error): TokenVerifier {
  return {
    verify: () => (failure ? Promise.reject(failure) : Promise.resolve(claims)),
  };
}

/**
 * An app whose routes are registered after — and outside — the plugin.
 *
 * Deliberately not inside a `register` callback: that is the arrangement the
 * `fastify-plugin` wrapper exists to make work, so it is the arrangement the
 * tests have to use.
 */
async function makeApp(options: OAuthPluginOptions): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(oauthPlugin, options);

  app.post('/invoke', (request) => {
    const user = getVerifiedUser(request);
    return {
      subject: user?.subject ?? null,
      tenant: user?.tenant ?? null,
      // Ordinally sorted by the middleware, so no compensating sort here.
      scopes: user?.scopes ?? [],
      issuerId: user?.issuerId ?? null,
      outbound: outboundIdentityHeaders(),
    };
  });

  app.get('/health', () => ({ status: 'ok' }));

  await app.ready();
  return app;
}

describe('oauthPlugin', () => {
  it('leaves the generic `user` decorator to the application', async () => {
    // `request.user` is what `@fastify/passport` decorates, and Fastify
    // refuses a second decorator under the same name outright
    // (FST_ERR_DEC_ALREADY_PRESENT) — so claiming it does not merely shadow
    // the app's own auth, it stops the app from registering it at all.
    const app = Fastify();
    await app.register(oauthPlugin, {
      verifier: stubVerifier(VERIFIED_CLAIMS),
    });

    expect(() =>
      (
        app as FastifyInstance & {
          decorateRequest(name: string, value: unknown): unknown;
        }
      ).decorateRequest('user', null)
    ).not.toThrow();
  });

  it('attaches the verified caller to the request', async () => {
    const app = await makeApp({
      scopes: ['agent.invoke'],
      verifier: stubVerifier(VERIFIED_CLAIMS),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/invoke',
      headers: { [USER_TOKEN_HEADER]: 'Bearer fake.jwt.token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      subject: 'alice@example.com',
      tenant: 'acme-corp',
      scopes: ['admin', 'agent.invoke'],
      issuerId: 'https://oidc.example.com',
    });
  });

  it('protects routes registered outside the plugin', async () => {
    // The encapsulation check. An unwrapped plugin would leave this route
    // wide open and still register without complaint.
    const app = await makeApp({ verifier: stubVerifier(VERIFIED_CLAIMS) });

    const response = await app.inject({ method: 'POST', url: '/invoke' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'oauth.missing_token' });
  });

  it('never caches an error body', async () => {
    const app = await makeApp({ verifier: stubVerifier(VERIFIED_CLAIMS) });

    const response = await app.inject({ method: 'POST', url: '/invoke' });

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('lets unauthenticated requests through when auth is not required', async () => {
    const app = await makeApp({
      requireAuth: false,
      verifier: stubVerifier(VERIFIED_CLAIMS),
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('answers 401 for a token that fails verification', async () => {
    const app = await makeApp({
      verifier: stubVerifier(
        {},
        new TokenVerificationError('oauth.invalid_signature')
      ),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/invoke',
      headers: { [USER_TOKEN_HEADER]: 'Bearer bad.token' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'oauth.invalid_signature' });
  });

  it('answers 403 when the token lacks a required scope', async () => {
    const app = await makeApp({
      scopes: ['admin.write'],
      verifier: stubVerifier({
        sub: 'bob@example.com',
        scp: ['agent.invoke'],
        iss: 'https://oidc.example.com',
        exp: epochSeconds(3600),
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/invoke',
      headers: { [USER_TOKEN_HEADER]: 'Bearer fake.jwt' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'oauth.missing_scope' });
  });

  it('answers 503 when key material is not loaded', async () => {
    const app = await makeApp({
      verifier: stubVerifier({}, new VerifierNotReadyError('JWKS loading')),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/invoke',
      headers: { [USER_TOKEN_HEADER]: 'Bearer fake.jwt' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'oauth.verifier_unavailable' });
  });

  it('answers the error envelope when the verifier throws something unexpected', async () => {
    // Fastify's `onRequest` hook is a callback, so an unexpected throw
    // rethrown here arrives as `next(error)` and is answered by Fastify's own
    // error handler: a 500 shaped nothing like the envelope.
    const app = await makeApp({
      verifier: stubVerifier({}, new RangeError('offset is out of bounds')),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/invoke',
      headers: { [USER_TOKEN_HEADER]: 'Bearer fake.jwt' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'oauth.verifier_unavailable' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('still gives a correctly-rejected token its own code', async () => {
    // The regression a catch-all ordered ahead of the specific checks would
    // cause: an expired token and an under-scoped one both collapsing to 503.
    const expired = await makeApp({
      verifier: stubVerifier(
        {},
        new TokenVerificationError('oauth.expired', 'token has expired')
      ),
    });

    const expiredResponse = await expired.inject({
      method: 'POST',
      url: '/invoke',
      headers: { [USER_TOKEN_HEADER]: 'Bearer expired.jwt' },
    });

    expect(expiredResponse.statusCode).toBe(401);
    expect(expiredResponse.json()).toEqual({ error: 'oauth.expired' });

    const underScoped = await makeApp({
      scopes: ['admin.write'],
      verifier: stubVerifier({
        sub: 'bob@example.com',
        scp: ['agent.invoke'],
        iss: 'https://oidc.example.com',
        exp: epochSeconds(3600),
      }),
    });

    const scopeResponse = await underScoped.inject({
      method: 'POST',
      url: '/invoke',
      headers: { [USER_TOKEN_HEADER]: 'Bearer fake.jwt' },
    });

    expect(scopeResponse.statusCode).toBe(403);
    expect(scopeResponse.json()).toEqual({ error: 'oauth.missing_scope' });
  });

  it('answers 503 when identity coordinates cannot be discovered', async () => {
    const app = await makeApp({});

    const response = await app.inject({
      method: 'POST',
      url: '/invoke',
      headers: { [USER_TOKEN_HEADER]: 'Bearer fake.jwt' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'oauth.not_configured' });
  });

  it('ignores the Authorization header', async () => {
    const app = await makeApp({ verifier: stubVerifier(VERIFIED_CLAIMS) });

    const response = await app.inject({
      method: 'POST',
      url: '/invoke',
      headers: { Authorization: 'Bearer some.jwt' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'oauth.missing_token' });
  });

  it('makes the raw token available to the handler for outbound calls', async () => {
    const app = await makeApp({ verifier: stubVerifier(VERIFIED_CLAIMS) });

    const response = await app.inject({
      method: 'POST',
      url: '/invoke',
      headers: { [USER_TOKEN_HEADER]: 'Bearer the.raw.token' },
    });

    expect(response.json()).toMatchObject({
      outbound: { 'X-Diagrid-User-Token': 'Bearer the.raw.token' },
    });
  });

  it('leaves no token behind once the request is answered', async () => {
    const app = await makeApp({ verifier: stubVerifier(VERIFIED_CLAIMS) });

    await app.inject({
      method: 'POST',
      url: '/invoke',
      headers: { [USER_TOKEN_HEADER]: 'Bearer the.raw.token' },
    });

    expect(outboundIdentityHeaders()).toEqual({});
  });

  it('reads scopes from a space-delimited scope claim', async () => {
    const app = await makeApp({
      scopes: ['read'],
      verifier: stubVerifier({
        sub: 'alice',
        scope: 'read write',
        iss: 'https://oidc.example.com',
        exp: epochSeconds(3600),
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/invoke',
      headers: { [USER_TOKEN_HEADER]: 'Bearer t' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ scopes: ['read', 'write'] });
  });
});

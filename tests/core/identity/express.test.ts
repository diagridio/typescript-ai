// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The Express middleware, driven through a real app over a loopback socket.
 *
 * A real socket rather than a fake request, because the parts most likely to
 * break a middleware — header casing, the order `res.status().set().json()`
 * writes things, whether `next()` was reached at all — are exactly the parts a
 * hand-rolled fake would not exercise.
 *
 * The verifier is injected rather than reached over the network: what is under
 * test here is the *decision* — which status, which code, and whether the
 * handler ran. Verification itself is covered by `./verifier.test.ts` against a
 * real keypair.
 */

import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

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
  oauthMiddleware,
  type OAuthMiddlewareOptions,
} from '@diagrid/agent-core/express';

import {
  epochSeconds,
  startServer,
  type RunningServer,
} from '../../fixtures/identity';

const USER_TOKEN_HEADER = 'X-Diagrid-User-Token';

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** A verifier that answers with `claims`, or fails with `failure`. */
function stubVerifier(claims: TokenClaims, failure?: Error): TokenVerifier {
  return {
    verify: () => (failure ? Promise.reject(failure) : Promise.resolve(claims)),
  };
}

const VERIFIED_CLAIMS: TokenClaims = {
  sub: 'alice@example.com',
  tid: 'acme-corp',
  scp: ['agent.invoke', 'admin'],
  iss: 'https://oidc.example.com',
  exp: epochSeconds(3600),
};

/**
 * An app with one protected route that echoes the caller back.
 *
 * `/invoke` also reports the outbound headers it would send, which is how the
 * propagation case checks the scope reaches a handler rather than only the
 * middleware.
 */
function makeApp(options: OAuthMiddlewareOptions): Express {
  const app = express();
  app.use(oauthMiddleware(options));

  app.post('/invoke', (req: Request, res: Response) => {
    const user = getVerifiedUser(req);
    res.json({
      subject: user?.subject ?? null,
      tenant: user?.tenant ?? null,
      // No compensating `.sort()`: the middleware attaches them sorted, so
      // this is the handler's own view.
      scopes: user?.scopes ?? [],
      issuerId: user?.issuerId ?? null,
      outbound: outboundIdentityHeaders(),
    });
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  return app;
}

interface Called {
  readonly status: number;
  readonly cacheControl: string | null;
  readonly body: Record<string, unknown>;
}

async function call(
  app: Express,
  path: string,
  headers: Record<string, string> = {},
  method = 'POST'
): Promise<Called> {
  running = await startServer(app);
  const response = await fetch(`${running.url}${path}`, { method, headers });

  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe('oauthMiddleware', () => {
  it("leaves the application's own `req.user` alone", async () => {
    // `req.user` belongs to whatever the app already authenticates with —
    // Passport puts its session user there, and `@types/passport` declares it
    // as `Express.User`. A library that claims the same slot overwrites the
    // app's user at runtime and collides with its declaration at compile time
    // (TS2717).
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user?: unknown }).user = { id: 'session-user' };
      next();
    });
    app.use(oauthMiddleware({ verifier: stubVerifier(VERIFIED_CLAIMS) }));
    app.post('/invoke', (req: Request, res: Response) => {
      res.json({
        appUser: (req as Request & { user?: unknown }).user ?? null,
        verified: getVerifiedUser(req)?.subject ?? null,
      });
    });

    const result = await call(app, '/invoke', {
      [USER_TOKEN_HEADER]: 'Bearer fake.jwt.token',
    });

    expect(result.body['appUser']).toEqual({ id: 'session-user' });
    expect(result.body['verified']).toBe('alice@example.com');
  });

  it('attaches the verified caller to the request', async () => {
    const app = makeApp({
      scopes: ['agent.invoke'],
      verifier: stubVerifier(VERIFIED_CLAIMS),
    });

    const result = await call(app, '/invoke', {
      [USER_TOKEN_HEADER]: 'Bearer fake.jwt.token',
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      subject: 'alice@example.com',
      tenant: 'acme-corp',
      scopes: ['admin', 'agent.invoke'],
      issuerId: 'https://oidc.example.com',
    });
  });

  it('attaches scopes ordinally sorted and deduplicated', async () => {
    // Scopes are a set: the order the token listed them in is not a grant, and
    // a repeated entry is not a second one.
    const app = makeApp({
      verifier: stubVerifier({
        ...VERIFIED_CLAIMS,
        scp: ['zeta', 'alpha', 'mu', 'beta', 'alpha'],
      }),
    });

    const result = await call(app, '/invoke', {
      [USER_TOKEN_HEADER]: 'Bearer fake.jwt.token',
    });

    expect(result.body['scopes']).toEqual(['alpha', 'beta', 'mu', 'zeta']);
  });

  it('sorts and deduplicates a space-delimited scope claim too', async () => {
    const app = makeApp({
      verifier: stubVerifier({
        ...VERIFIED_CLAIMS,
        scp: undefined,
        scope: 'write read write',
      }),
    });

    const result = await call(app, '/invoke', {
      [USER_TOKEN_HEADER]: 'Bearer fake.jwt.token',
    });

    expect(result.body['scopes']).toEqual(['read', 'write']);
  });

  it('rejects a request with no token', async () => {
    const app = makeApp({ verifier: stubVerifier(VERIFIED_CLAIMS) });

    const result = await call(app, '/invoke');

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'oauth.missing_token' });
  });

  it('never caches an error body', async () => {
    // The response names a specific caller's failure; a shared cache serving it
    // to the next caller would be an information leak and a wrong answer.
    const app = makeApp({ verifier: stubVerifier(VERIFIED_CLAIMS) });

    const result = await call(app, '/invoke');

    expect(result.cacheControl).toBe('no-store');
  });

  it('lets unauthenticated requests through when auth is not required', async () => {
    const app = makeApp({
      requireAuth: false,
      verifier: stubVerifier(VERIFIED_CLAIMS),
    });

    const result = await call(app, '/health', {}, 'GET');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'ok' });
  });

  it('still verifies a token that is present when auth is not required', async () => {
    // `requireAuth: false` opens the route to anonymous callers; it does not
    // make a *bad* token acceptable.
    const app = makeApp({
      requireAuth: false,
      verifier: stubVerifier(
        {},
        new TokenVerificationError('oauth.invalid_signature')
      ),
    });

    const result = await call(app, '/invoke', {
      [USER_TOKEN_HEADER]: 'Bearer bad.token',
    });

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'oauth.invalid_signature' });
  });

  it('answers 401 for a token that fails verification', async () => {
    const app = makeApp({
      verifier: stubVerifier(
        {},
        new TokenVerificationError('oauth.invalid_signature')
      ),
    });

    const result = await call(app, '/invoke', {
      [USER_TOKEN_HEADER]: 'Bearer bad.token',
    });

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'oauth.invalid_signature' });
  });

  it('answers 403 when the token lacks a required scope', async () => {
    const app = makeApp({
      scopes: ['admin.write'],
      verifier: stubVerifier({
        sub: 'bob@example.com',
        scp: ['agent.invoke'],
        iss: 'https://oidc.example.com',
        exp: epochSeconds(3600),
      }),
    });

    const result = await call(app, '/invoke', {
      [USER_TOKEN_HEADER]: 'Bearer fake.jwt',
    });

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: 'oauth.missing_scope' });
  });

  it('answers 503 when key material is not loaded', async () => {
    const app = makeApp({
      verifier: stubVerifier({}, new VerifierNotReadyError('JWKS loading')),
    });

    const result = await call(app, '/invoke', {
      [USER_TOKEN_HEADER]: 'Bearer fake.jwt',
    });

    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'oauth.verifier_unavailable' });
  });

  it('answers the error envelope when the verifier throws something unexpected', async () => {
    // A `RangeError` is nothing the verifier contract names. Rethrown, it
    // reaches Express as a framework 500 with an HTML body and no
    // `Cache-Control`; an app that cannot adjudicate any caller is unavailable,
    // not presented with a bad token.
    const app = makeApp({
      verifier: stubVerifier({}, new RangeError('offset is out of bounds')),
    });

    const result = await call(app, '/invoke', {
      [USER_TOKEN_HEADER]: 'Bearer fake.jwt',
    });

    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'oauth.verifier_unavailable' });
    expect(result.cacheControl).toBe('no-store');
  });

  it('answers the error envelope for a throw that is not an Error at all', async () => {
    const app = makeApp({
      verifier: {
        // A non-Error rejection is the point of this case, so the rule that
        // forbids one is off for this line only.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        verify: () => Promise.reject('a bare string'),
      },
    });

    const result = await call(app, '/invoke', {
      [USER_TOKEN_HEADER]: 'Bearer fake.jwt',
    });

    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'oauth.verifier_unavailable' });
  });

  it('still gives a correctly-rejected token its own code', async () => {
    // The regression the broad catch above could cause: a catch-all ordered
    // ahead of the specific checks would turn an expired token into a 503 and
    // a missing scope into one too, losing the 401 and the 403 that tell a
    // caller which of the two it was.
    const expired = makeApp({
      verifier: stubVerifier(
        {},
        new TokenVerificationError('oauth.expired', 'token has expired')
      ),
    });

    const expiredResult = await call(expired, '/invoke', {
      [USER_TOKEN_HEADER]: 'Bearer expired.jwt',
    });

    expect(expiredResult.status).toBe(401);
    expect(expiredResult.body).toEqual({ error: 'oauth.expired' });

    await running?.close();
    running = undefined;

    const underScoped = makeApp({
      scopes: ['admin.write'],
      verifier: stubVerifier({
        sub: 'bob@example.com',
        scp: ['agent.invoke'],
        iss: 'https://oidc.example.com',
        exp: epochSeconds(3600),
      }),
    });

    const scopeResult = await call(underScoped, '/invoke', {
      [USER_TOKEN_HEADER]: 'Bearer fake.jwt',
    });

    expect(scopeResult.status).toBe(403);
    expect(scopeResult.body).toEqual({ error: 'oauth.missing_scope' });
  });

  it('answers 503 when identity coordinates cannot be discovered', async () => {
    // No injected verifier, no sidecar port and no issuer in the environment
    // (`tests/setup.unit.ts` guarantees the last two), so building one fails —
    // the server's misconfiguration, not the caller's bad token.
    const app = makeApp({});

    const result = await call(app, '/invoke', {
      [USER_TOKEN_HEADER]: 'Bearer fake.jwt',
    });

    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'oauth.not_configured' });
  });

  it('does not build a verifier for a request that carries no token', async () => {
    // The unconfigured app above answers 503 for a token it cannot check;
    // with no token at all the answer is still 401, because the missing
    // header is decided before any verifier is needed.
    const app = makeApp({});

    const result = await call(app, '/invoke');

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'oauth.missing_token' });
  });

  it('ignores the Authorization header', async () => {
    // That header belongs to whatever the app's own front door uses. Treating
    // it as a dp-Sentry token would let an unrelated bearer token through.
    const app = makeApp({ verifier: stubVerifier(VERIFIED_CLAIMS) });

    const result = await call(app, '/invoke', {
      Authorization: 'Bearer some.jwt',
    });

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'oauth.missing_token' });
  });

  it('makes the raw token available to the handler for outbound calls', async () => {
    const app = makeApp({ verifier: stubVerifier(VERIFIED_CLAIMS) });

    const result = await call(app, '/invoke', {
      [USER_TOKEN_HEADER]: 'Bearer the.raw.token',
    });

    expect(result.body['outbound']).toEqual({
      'X-Diagrid-User-Token': 'Bearer the.raw.token',
    });
  });

  it('leaves no token behind once the request is answered', async () => {
    const app = makeApp({ verifier: stubVerifier(VERIFIED_CLAIMS) });

    await call(app, '/invoke', {
      [USER_TOKEN_HEADER]: 'Bearer the.raw.token',
    });

    expect(outboundIdentityHeaders()).toEqual({});
  });

  it('accepts a bare token with no scheme prefix', async () => {
    const app = makeApp({ verifier: stubVerifier(VERIFIED_CLAIMS) });

    const result = await call(app, '/invoke', {
      [USER_TOKEN_HEADER]: 'the.raw.token',
    });

    expect(result.status).toBe(200);
    expect(result.body['outbound']).toEqual({
      'X-Diagrid-User-Token': 'Bearer the.raw.token',
    });
  });

  it('accepts a lower-cased scheme prefix', async () => {
    const app = makeApp({ verifier: stubVerifier(VERIFIED_CLAIMS) });

    const result = await call(app, '/invoke', {
      [USER_TOKEN_HEADER]: 'bearer the.raw.token',
    });

    expect(result.status).toBe(200);
    expect(result.body['outbound']).toEqual({
      'X-Diagrid-User-Token': 'Bearer the.raw.token',
    });
  });

  it('reads scopes from a space-delimited scope claim', async () => {
    const app = makeApp({
      scopes: ['read'],
      verifier: stubVerifier({
        sub: 'alice',
        scope: 'read write',
        iss: 'https://oidc.example.com',
        exp: epochSeconds(3600),
      }),
    });

    const result = await call(app, '/invoke', {
      [USER_TOKEN_HEADER]: 'Bearer t',
    });

    expect(result.status).toBe(200);
    expect(result.body['scopes']).toEqual(['read', 'write']);
  });

  it('falls back to the tenant claim when tid is absent', async () => {
    const app = makeApp({
      verifier: stubVerifier({
        sub: 'alice',
        tenant: 'legacy-corp',
        iss: 'https://oidc.example.com',
        exp: epochSeconds(3600),
      }),
    });

    const result = await call(app, '/invoke', {
      [USER_TOKEN_HEADER]: 'Bearer t',
    });

    expect(result.body['tenant']).toBe('legacy-corp');
  });
});

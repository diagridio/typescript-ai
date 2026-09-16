// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * A signing keypair the identity tests own outright.
 *
 * The point of the identity suite is the cases where verification *fails*, and
 * those are only worth anything if the test can produce a token that is wrong
 * in one specific, chosen way: signed by the wrong key, expired by a chosen
 * number of seconds, carrying `alg: none`. That rules out both an upstream
 * issuer and a live JWKS endpoint — neither will issue a deliberately broken
 * token on request — so the keypair is generated here and the public half is
 * handed to the verifier directly as its key resolver.
 */

import { createServer } from 'node:http';

import type { Express } from 'express';
import { SignJWT, UnsecuredJWT, exportJWK, generateKeyPair } from 'jose';
import type { JSONWebKeySet, JWTPayload, JWTVerifyGetKey } from 'jose';

/** The algorithm dp-Sentry signs with, and the one the fixture mirrors. */
export const FIXTURE_ALGORITHM = 'RS256';

/** An HMAC secret, used only to prove an HS256 token is refused. */
const HS256_SECRET = new TextEncoder().encode(
  'a-symmetric-secret-long-enough-for-hs256'
);

export interface Keypair {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}

/** Generate one RS256 keypair. Slow enough to be worth a `beforeAll`. */
export async function generateFixtureKeypair(): Promise<Keypair> {
  const { privateKey, publicKey } = await generateKeyPair(FIXTURE_ALGORITHM);
  return { privateKey, publicKey };
}

/** A key resolver that always answers with `publicKey`, fetching nothing. */
export function fixtureKeyResolver(publicKey: CryptoKey): JWTVerifyGetKey {
  return () => Promise.resolve(publicKey);
}

/**
 * The public half of a fixture keypair, as a JWKS endpoint would serve it.
 *
 * For the one case an injected key resolver cannot cover: a verifier that
 * `buildVerifier` built for itself, whose key material must therefore arrive
 * over the stubbed `fetch` the way a real key set does.
 */
export async function jwksBody(publicKey: CryptoKey): Promise<JSONWebKeySet> {
  const jwk = await exportJWK(publicKey);
  return { keys: [{ ...jwk, alg: FIXTURE_ALGORITHM, use: 'sig' }] };
}

/** Sign `claims` with `privateKey`, under `alg` (RS256 unless overridden). */
export function signToken(
  privateKey: CryptoKey,
  claims: JWTPayload,
  alg: string = FIXTURE_ALGORITHM
): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg }).sign(privateKey);
}

/** An HS256-signed token — the classic algorithm-confusion attempt. */
export function signHs256Token(claims: JWTPayload): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .sign(HS256_SECRET);
}

/** An `alg: none` token: well-formed, entirely unauthenticated. */
export function unsecuredToken(claims: JWTPayload): string {
  return new UnsecuredJWT(claims).encode();
}

/** Seconds since the epoch, `offsetSeconds` from now. */
export function epochSeconds(offsetSeconds = 0): number {
  return Math.floor(Date.now() / 1000) + offsetSeconds;
}

/** A minimal payload that satisfies the required `exp` / `iss` / `sub`. */
export function validClaims(overrides: JWTPayload = {}): JWTPayload {
  return {
    sub: 'alice@example.com',
    iss: 'https://oidc.example.com',
    exp: epochSeconds(3600),
    iat: epochSeconds(),
    ...overrides,
  };
}

export interface RunningServer {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Serve `app` on an ephemeral loopback port.
 *
 * A real socket rather than a mocked request object: Express's own routing,
 * header casing and JSON body handling are part of what the middleware tests
 * assert.
 */
export async function startServer(app: Express): Promise<RunningServer> {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The decision seam, driven directly.
 *
 * `./express.test.ts` and `./fastify.test.ts` cover the same decisions through
 * a real app, which is the right level for almost everything. What cannot be
 * reached from there is a failure no shipped code path produces — a verifier
 * build that throws something `buildVerifier` does not raise, or a verifier
 * whose `verify` throws outside its contract — so those are injected here, at
 * the seam the two adapters share.
 *
 * `authenticate` is module-internal, so these cases reach it by path.
 */

import { describe, expect, it } from 'vitest';

import {
  HTTP_FORBIDDEN,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_UNAUTHORIZED,
  authenticate,
} from '../../../packages/core/src/identity/authenticate';
import {
  IdentityNotConfiguredError,
  OAuthErrorCodes,
  TokenVerificationError,
  VerifierNotReadyError,
} from '../../../packages/core/src/identity/errors';
import type { TokenVerifier } from '../../../packages/core/src/identity/verifier';

/** The `process.emitWarning` type a configuration refusal carries. */
const NOT_CONFIGURED_WARNING = 'DiagridIdentityNotConfigured';

/** The type an unexpected failure on the verification path carries. */
const VERIFY_FAILED_WARNING = 'DiagridIdentityVerifyFailed';

const CAPTURED_WARNINGS: readonly string[] = [
  NOT_CONFIGURED_WARNING,
  VERIFY_FAILED_WARNING,
];

/** Identity warnings emitted while `run` was in flight. */
async function warningsDuring(run: () => Promise<unknown>): Promise<Error[]> {
  const seen: Error[] = [];
  const listener = (warning: Error): void => {
    if (CAPTURED_WARNINGS.includes(warning.name)) {
      seen.push(warning);
    }
  };
  process.on('warning', listener);
  try {
    await run();
    // `process.emitWarning` dispatches on the next tick.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('warning', listener);
  }
  return seen;
}

const failingBuild = (error: Error) => () => Promise.reject(error);

describe('authenticate: a verifier build that fails', () => {
  it('fails closed with 503 oauth.not_configured, whatever the failure was', async () => {
    // Rethrowing instead would hand the framework a 500 with no `{"error"}`
    // body and no `Cache-Control: no-store`, and — behind a cached build —
    // replay it to every later request.
    const outcome = await authenticate(
      'Bearer some.jwt',
      {},
      failingBuild(new TypeError('createRemoteJWKSet exploded'))
    );

    expect(outcome).toEqual({
      kind: 'rejected',
      status: HTTP_SERVICE_UNAVAILABLE,
      code: OAuthErrorCodes.NotConfigured,
    });
  });

  it('says out loud what it could not build', async () => {
    // An app answering 503 to every request with nothing in its log is the
    // failure this warning exists for.
    const warnings = await warningsDuring(() =>
      authenticate('Bearer some.jwt', {}, failingBuild(new Error('boom')))
    );

    // Matched on the message rather than the count: `process.emitWarning`
    // dispatches on a later tick, so the case above this one can still land
    // in this capture.
    expect(warnings.map((warning) => warning.message).join('\n')).toContain(
      'boom'
    );
  });

  it('warns for a not-configured failure as well', async () => {
    // The commoner half: nothing supplied an issuer. Same answer on the wire,
    // and it must not be the silent one either.
    const warnings = await warningsDuring(() =>
      authenticate(
        'Bearer some.jwt',
        {},
        failingBuild(new IdentityNotConfiguredError('no issuer anywhere'))
      )
    );

    expect(warnings.map((warning) => warning.message).join('\n')).toContain(
      'no issuer anywhere'
    );
  });

  it('never builds a verifier for a request that carries no token', async () => {
    // The missing header is decided before any verifier is needed, so a
    // broken build cannot turn a 401 into a 503.
    const outcome = await authenticate(
      undefined,
      {},
      failingBuild(new TypeError('must not be called'))
    );

    expect(outcome).toEqual({
      kind: 'rejected',
      status: HTTP_UNAUTHORIZED,
      code: OAuthErrorCodes.MissingToken,
    });
  });
});

/** A verifier whose `verify` always fails with `failure`. */
function failingVerifier(failure: Error): () => Promise<TokenVerifier> {
  return () => Promise.resolve({ verify: () => Promise.reject(failure) });
}

describe('authenticate: a verify that fails unexpectedly', () => {
  it('answers 503 oauth.verifier_unavailable', async () => {
    const outcome = await authenticate(
      'Bearer some.jwt',
      {},
      failingVerifier(new RangeError('offset is out of bounds'))
    );

    expect(outcome).toEqual({
      kind: 'rejected',
      status: HTTP_SERVICE_UNAVAILABLE,
      code: OAuthErrorCodes.VerifierUnavailable,
    });
  });

  it('says out loud what threw, with its type', async () => {
    const warnings = await warningsDuring(() =>
      authenticate(
        'Bearer some.jwt',
        {},
        failingVerifier(new RangeError('offset is out of bounds'))
      )
    );

    const said = warnings.map((warning) => warning.message).join('\n');
    expect(said).toContain('RangeError');
    expect(said).toContain('offset is out of bounds');
  });

  it('rethrows an aborted request rather than answering it', async () => {
    // A client that disconnected mid-verification is not a 503: the framework
    // has to see the abort to unwind the response it is no longer writing.
    const aborted = new DOMException(
      'This operation was aborted',
      'AbortError'
    );

    await expect(
      authenticate('Bearer some.jwt', {}, failingVerifier(aborted))
    ).rejects.toBe(aborted);
  });

  it('keeps the specific failures ahead of the broad one', async () => {
    // The ordering check. A catch-all placed first would answer 503 for all
    // three of these, losing the 401 that says re-authenticate and the 403
    // that says this token will never be enough.
    const notReady = await authenticate(
      'Bearer some.jwt',
      {},
      failingVerifier(new VerifierNotReadyError('JWKS loading'))
    );
    expect(notReady).toEqual({
      kind: 'rejected',
      status: HTTP_SERVICE_UNAVAILABLE,
      code: OAuthErrorCodes.VerifierUnavailable,
    });

    const expired = await authenticate(
      'Bearer some.jwt',
      {},
      failingVerifier(new TokenVerificationError(OAuthErrorCodes.Expired))
    );
    expect(expired).toEqual({
      kind: 'rejected',
      status: HTTP_UNAUTHORIZED,
      code: OAuthErrorCodes.Expired,
    });

    const underScoped = await authenticate(
      'Bearer some.jwt',
      {},
      failingVerifier(new TokenVerificationError(OAuthErrorCodes.MissingScope))
    );
    expect(underScoped).toEqual({
      kind: 'rejected',
      status: HTTP_FORBIDDEN,
      code: OAuthErrorCodes.MissingScope,
    });
  });
});

// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The identity error vocabulary.
 *
 * The code strings are the cross-SDK wire contract: they are what a caller
 * matches on and what lands in the JSON error body, so they are reproduced
 * verbatim rather than re-cased into a TypeScript-looking enum. The carrier is
 * a `code` property on a typed `Error` subclass, so a caller can narrow with
 * `instanceof` and then switch on the code.
 */

/** Every error code the middleware can answer with. */
export const OAuthErrorCodes = {
  /** No `X-Diagrid-User-Token` on a request that requires one. 401. */
  MissingToken: 'oauth.missing_token',
  /** Identity coordinates could not be discovered or configured. 503. */
  NotConfigured: 'oauth.not_configured',
  /** JWKS key material is not loaded yet. 503. */
  VerifierUnavailable: 'oauth.verifier_unavailable',
  /** `exp` is in the past, beyond the tolerated clock skew. 401. */
  Expired: 'oauth.expired',
  /** `iss` does not match the configured issuer. 401. */
  InvalidIssuer: 'oauth.invalid_issuer',
  /** `aud` does not match the configured audience. 401. */
  InvalidAudience: 'oauth.invalid_audience',
  /** The signature does not verify against the JWKS key. 401. */
  InvalidSignature: 'oauth.invalid_signature',
  /** The token is not a well-formed JWS. 401. */
  DecodeError: 'oauth.decode_error',
  /** Any other claim or algorithm validation failure. 401. */
  InvalidToken: 'oauth.invalid_token',
  /** The token verified but lacks a required scope. 403. */
  MissingScope: 'oauth.missing_scope',
} as const;

/** Any one of the {@link OAuthErrorCodes} values. */
export type OAuthErrorCode =
  (typeof OAuthErrorCodes)[keyof typeof OAuthErrorCodes];

/** Signature or claim validation failed. */
export class TokenVerificationError extends Error {
  /** The `oauth.*` code this failure reports to the caller. */
  readonly code: OAuthErrorCode;

  constructor(code: OAuthErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'TokenVerificationError';
    this.code = code;
  }
}

/**
 * JWKS key material has not loaded yet.
 *
 * Distinct from {@link TokenVerificationError} because it is the server's
 * problem, not the caller's: it maps to 503, not 401, so a client knows to
 * retry rather than to re-authenticate.
 */
export class VerifierNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifierNotReadyError';
  }
}

/**
 * Identity coordinates could not be resolved, or resolved to something unusable.
 *
 * Maps to 503 {@link OAuthErrorCodes.NotConfigured}. Raised when no source
 * supplied an issuer, and when the resolved JWKS URI will not parse, is not
 * `http`/`https`, or is plaintext on a routable host.
 */
export class IdentityNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityNotConfiguredError';
  }
}

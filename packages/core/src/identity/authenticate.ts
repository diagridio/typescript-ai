// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The inbound verification flow, with no framework in it.
 *
 * Node has no common web-framework layer, so this SDK ships an Express
 * middleware and a Fastify plugin; the decision each makes about a request is
 * made here, once, so the two cannot drift.
 *
 * Not exported from the package barrel: it is the seam between the two
 * adapters, not public surface.
 */

import {
  OAuthErrorCodes,
  TokenVerificationError,
  VerifierNotReadyError,
} from './errors';
import type { OAuthErrorCode } from './errors';
import { BEARER_PREFIX } from './outbound';
import type { OAuthConfig, TokenClaims, VerifiedUser } from './types';
import type { TokenVerifier } from './verifier';

export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_SERVICE_UNAVAILABLE = 503;

/** An error body must never be cached: the next caller is a different user. */
export const CACHE_CONTROL_HEADER = 'Cache-Control';
export const CACHE_CONTROL_NO_STORE = 'no-store';

/** Claims a scope list may arrive under, in the order they are consulted. */
const SCOPE_CLAIMS = ['scp', 'scope', 'scopes'] as const;

/** Claims a tenant may arrive under, in the order they are consulted. */
const TENANT_CLAIMS = ['tid', 'tenant'] as const;

/**
 * Name and code the warning for a refused-for-configuration request carries.
 *
 * `process.emitWarning`, as everywhere else in this workspace: the type and
 * code give an operator something stable to filter on or to promote to an
 * error.
 */
const NOT_CONFIGURED_WARNING = {
  type: 'DiagridIdentityNotConfigured',
  code: 'DIAGRID_IDENTITY_NOT_CONFIGURED',
} as const;

/** Said out loud when a request is refused because no verifier could be built. */
const NOT_CONFIGURED_MESSAGE = (error: unknown): string =>
  'identity verifier could not be built; refusing the request with 503 ' +
  `${OAuthErrorCodes.NotConfigured} (${describe(error)})`;

/** Name and code the warning for an unexpectedly failed verification carries. */
const VERIFY_FAILED_WARNING = {
  type: 'DiagridIdentityVerifyFailed',
  code: 'DIAGRID_IDENTITY_VERIFY_FAILED',
} as const;

/** Said out loud when verification failed for a reason nothing here names. */
const VERIFY_FAILED_MESSAGE = (error: unknown): string =>
  'identity verification failed unexpectedly; refusing the request with 503 ' +
  `${OAuthErrorCodes.VerifierUnavailable} (${describe(error)})`;

/** `DOMException.name` an aborted request arrives under. */
const ABORT_ERROR_NAME = 'AbortError';

/** What the middleware should do with a request, once it has decided. */
export type AuthOutcome =
  /** No token, and none was required. Pass it through unauthenticated. */
  | { readonly kind: 'anonymous' }
  /** Verified. Attach the user and run the handler inside the token scope. */
  | {
      readonly kind: 'authenticated';
      readonly user: VerifiedUser;
      readonly token: string;
    }
  /** Refused. Answer with this status and code, and do not call the handler. */
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly code: OAuthErrorCode;
    };

/**
 * Decide what to do with one inbound request.
 *
 * Fails closed at every step: a missing token, an unverifiable token, an
 * unreachable JWKS and an unconfigured verifier are all refusals, and the
 * handler runs only on the one path where a token verified and carried every
 * scope the config asked for.
 */
export async function authenticate(
  headerValue: string | undefined,
  config: OAuthConfig,
  getVerifier: () => Promise<TokenVerifier>
): Promise<AuthOutcome> {
  const token = trimBearer(headerValue ?? '');

  if (!token) {
    // `requireAuth` defaults to true, so only an explicit `false` opens the
    // route up — an omitted or misspelled field cannot accidentally disable
    // authentication.
    return config.requireAuth === false
      ? { kind: 'anonymous' }
      : rejected(HTTP_UNAUTHORIZED, OAuthErrorCodes.MissingToken);
  }

  let verifier: TokenVerifier;
  try {
    verifier = await getVerifier();
  } catch (error: unknown) {
    // Any failure, not only `IdentityNotConfiguredError`: a verifier that
    // cannot be built is a server-side configuration problem whatever threw,
    // and anything rethrown here reaches the framework as a 500 with no
    // `{"error"}` body and no `Cache-Control: no-store`.
    process.emitWarning(NOT_CONFIGURED_MESSAGE(error), NOT_CONFIGURED_WARNING);
    return rejected(HTTP_SERVICE_UNAVAILABLE, OAuthErrorCodes.NotConfigured);
  }

  let claims: TokenClaims;
  try {
    claims = await verifier.verify(token);
  } catch (error: unknown) {
    if (error instanceof VerifierNotReadyError) {
      return rejected(
        HTTP_SERVICE_UNAVAILABLE,
        OAuthErrorCodes.VerifierUnavailable
      );
    }
    if (error instanceof TokenVerificationError) {
      const status =
        error.code === OAuthErrorCodes.MissingScope
          ? HTTP_FORBIDDEN
          : HTTP_UNAUTHORIZED;
      return rejected(status, error.code);
    }
    // The framework has to see an abort: the caller disconnected, and there is
    // no longer a response to write.
    if (isAbortError(error)) {
      throw error;
    }
    // Ordered last, and that ordering is the whole of its correctness: ahead of
    // the two checks above it would answer 503 for a token that was correctly
    // refused, losing both the 401 and the missing-scope 403. Anything still
    // here is a defect rather than a verdict on the token, so no caller can be
    // adjudicated at all — which is what `oauth.verifier_unavailable` means.
    process.emitWarning(VERIFY_FAILED_MESSAGE(error), VERIFY_FAILED_WARNING);
    return rejected(
      HTTP_SERVICE_UNAVAILABLE,
      OAuthErrorCodes.VerifierUnavailable
    );
  }

  const scopes = extractScopes(claims);
  if (missingScopes(config.scopes ?? [], scopes).length > 0) {
    return rejected(HTTP_FORBIDDEN, OAuthErrorCodes.MissingScope);
  }

  return {
    kind: 'authenticated',
    token,
    user: {
      subject: claimString(claims, ['sub']),
      tenant: claimString(claims, TENANT_CLAIMS),
      scopes,
      claims,
      issuerId: claimString(claims, ['iss']),
    },
  };
}

/**
 * Strip the scheme prefix from a header value.
 *
 * Case-insensitive, because `bearer` and `Bearer` both appear in the wild,
 * and tolerant of surrounding whitespace. A bare token with no prefix is
 * returned unchanged.
 */
export function trimBearer(value: string): string {
  const trimmed = value.trim();
  if (trimmed.toUpperCase().startsWith(BEARER_PREFIX.toUpperCase())) {
    return trimmed.slice(BEARER_PREFIX.length).trim();
  }
  return trimmed;
}

/**
 * Read the scopes off a verified token.
 *
 * Three claim names, because the three issuers that matter disagree: `scp` is
 * Entra's, `scope` is the OAuth 2.0 spec's, and `scopes` appears in older
 * dp-Sentry tokens. Either a list or a whitespace-delimited string.
 *
 * The result is ordinally sorted and deduplicated by {@link canonicalScopes}:
 * scopes are a set, and the list is wire-visible, so the order a token happened
 * to use must not decide what a handler's JSON body says.
 */
export function extractScopes(claims: TokenClaims): readonly string[] {
  for (const name of SCOPE_CLAIMS) {
    const value = claims[name];
    if (Array.isArray(value) && value.length > 0) {
      return canonicalScopes(
        value.filter((entry): entry is string => typeof entry === 'string')
      );
    }
    if (typeof value === 'string' && value !== '') {
      return canonicalScopes(
        value.split(/\s+/).filter((entry) => entry !== '')
      );
    }
  }
  return [];
}

/**
 * Which of `required` the token did not carry, in the same canonical order.
 *
 * Sorted for the same reason the granted scopes are: `OAuthConfig.scopes` is a
 * set the caller wrote down in whatever order read well.
 */
export function missingScopes(
  required: readonly string[],
  granted: readonly string[]
): readonly string[] {
  const held = new Set(granted);
  return canonicalScopes(required.filter((scope) => !held.has(scope)));
}

/**
 * A scope list as every SDK reports it: ordinally sorted, no duplicates.
 *
 * An `Array` rather than a `Set`, because a `Set` serialises to `{}` and
 * handing the list to `res.json()` is the commonest thing a handler does with
 * it. Only the contents need set semantics.
 */
function canonicalScopes(scopes: readonly string[]): readonly string[] {
  return [...new Set(scopes)].sort();
}

function rejected(status: number, code: OAuthErrorCode): AuthOutcome {
  return { kind: 'rejected', status, code };
}

/** Whether `error` is the abort a disconnected caller produces. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === ABORT_ERROR_NAME;
}

/** `Name: message`, so the log says whether this was a config error or a bug. */
function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

/** First of `names` present as a string, or `''`. */
function claimString(claims: TokenClaims, names: readonly string[]): string {
  for (const name of names) {
    const value = claims[name];
    if (typeof value === 'string') {
      return value;
    }
  }
  return '';
}

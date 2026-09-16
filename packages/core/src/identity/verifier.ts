// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * JWKS-backed JWT verification for dp-Sentry-signed tokens.
 *
 * Every number and name below is the cross-SDK contract: 120s of clock skew, a
 * 300s JWKS cache, `RS256`/`ES256` only, `exp`/`iss`/`sub` required, and the
 * four-source coordinate discovery.
 *
 * `jose` does the crypto, and it refuses a token whose `alg` is outside
 * {@link ALLOWED_ALGORITHMS} before it looks at anything else — which is the
 * one check that stops the classic algorithm-confusion bypass.
 */

import { isIP } from 'node:net';

import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey, JWTVerifyOptions } from 'jose';

import {
  IdentityNotConfiguredError,
  OAuthErrorCodes,
  TokenVerificationError,
  VerifierNotReadyError,
} from './errors';
import type { TokenClaims } from './types';

/** Clock skew tolerated on `exp` and `nbf`, in seconds. */
export const CLOCK_SKEW_SECONDS = 120;

/** How long a fetched JWKS stays fresh before it is re-fetched, in seconds. */
export const JWKS_CACHE_LIFETIME_SECONDS = 300;

/** The only signature algorithms a dp-Sentry token may be signed with. */
export const ALLOWED_ALGORITHMS: readonly string[] = ['RS256', 'ES256'];

/** Claims every token must carry, whatever else it does or does not assert. */
export const REQUIRED_CLAIMS: readonly string[] = ['exp', 'iss', 'sub'];

/** Sidecar HTTP port, Catalyst's own name for it. Consulted first. */
export const CATALYST_DAPR_HTTP_PORT_ENV = 'CATALYST_DAPR_HTTP_PORT';

/** Sidecar HTTP port, Dapr's name for it. Consulted second. */
export const DAPR_HTTP_PORT_ENV = 'DAPR_HTTP_PORT';

/**
 * Base URL of a remote sidecar, consulted when no local one answers.
 *
 * `diagrid dev run` runs the app on a developer's machine against a
 * Catalyst-hosted sidecar, so nothing is listening on loopback and the local
 * probe cannot answer.
 */
export const DAPR_HTTP_ENDPOINT_ENV = 'DAPR_HTTP_ENDPOINT';

/** API token a remote sidecar authenticates the metadata request with. */
export const DAPR_API_TOKEN_ENV = 'DAPR_API_TOKEN';

/** Issuer override, consulted when the metadata endpoint is unreachable. */
export const DP_SENTRY_ISSUER_ENV = 'DIAGRID_DP_SENTRY_ISSUER';

/** Audience override, read alongside {@link DP_SENTRY_ISSUER_ENV}. */
export const DP_SENTRY_AUDIENCE_ENV = 'DIAGRID_DP_SENTRY_AUDIENCE';

/** Sidecar path carrying the `identity` block. */
const METADATA_PATH = '/v1.0/metadata';

/** Budget for the metadata probe. Discovery must not stall a cold start. */
const METADATA_TIMEOUT_MS = 5_000;

/** Header a remote sidecar authenticates the metadata request with. */
const API_TOKEN_HEADER = 'dapr-api-token';

/** `/`, compared by code unit so trimming needs no regex. */
const SLASH_CHAR_CODE = 47;

/** Path appended to an issuer that did not publish its own `jwks_uri`. */
const JWKS_PATH = '/jwks.json';

const MILLISECONDS_PER_SECOND = 1_000;

/** The only transport a key set may be fetched over off loopback. */
const HTTPS_PROTOCOL = 'https:';

/** The one transport `allowInsecureJwks` relaxes, and the only one. */
const HTTP_PROTOCOL = 'http:';

/** Hostnames that resolve to this machine, spelled as `URL` reports them. */
const LOOPBACK_HOSTNAMES: readonly string[] = ['localhost', '[::1]', '::1'];

/** The first octet of `127.0.0.0/8`, every address of which is loopback. */
const LOOPBACK_IPV4_FIRST_OCTET = '127';

/** The only IPv6 address that is loopback, as `isIP` accepts it. */
const LOOPBACK_IPV6 = '::1';

/** IP versions {@link isIP} reports. */
const IPV4 = 4;
const IPV6 = 6;

/** Guidance shown when nothing supplied an issuer. */
const CANNOT_DISCOVER_MESSAGE =
  'Cannot discover identity coordinates: set issuer/jwksUri explicitly, ' +
  `configure the sidecar metadata endpoint (${DAPR_HTTP_PORT_ENV} locally ` +
  `or ${DAPR_HTTP_ENDPOINT_ENV} for a remote sidecar), or set ` +
  `${DP_SENTRY_ISSUER_ENV}`;

/** Guidance shown when the resolved key set would be fetched in the clear. */
const INSECURE_JWKS_MESSAGE = (jwksUri: string): string =>
  `Refusing to fetch JWKS over an insecure transport: ${jwksUri}. The key ` +
  'set is the root of trust, so it must be served over https. Use an https ' +
  'URI, point at a loopback host, or set allowInsecureJwks to opt out.';

/** Guidance shown when the resolved key set is neither http nor https. */
const UNSUPPORTED_JWKS_SCHEME_MESSAGE = (jwksUri: string): string =>
  `Refusing to fetch JWKS over an unsupported scheme: ${jwksUri}. A key set ` +
  'is fetched over https, and allowInsecureJwks relaxes plain http only — ' +
  'opting into plaintext says nothing about reading keys off a filesystem.';

/** Guidance shown when the resolved JWKS URI will not parse at all. */
const UNUSABLE_JWKS_MESSAGE = (jwksUri: string): string =>
  `Unusable JWKS URI: ${jwksUri}. It is not a URL, so no key set can be ` +
  'fetched from it. Set jwksUri to an absolute https URI, or leave it unset ' +
  'and let discovery supply it.';

/**
 * Name and code the warning for a failed discovery probe carries.
 *
 * `process.emitWarning` rather than `console.warn`, as everywhere else in this
 * workspace: the type and code give an operator something stable to filter on
 * or to promote to an error.
 */
const DISCOVERY_FAILED_WARNING = {
  type: 'DiagridIdentityDiscoveryFailed',
  code: 'DIAGRID_IDENTITY_DISCOVERY_FAILED',
} as const;

/** The same, for a token about to be sent over a plaintext transport. */
const PLAINTEXT_API_TOKEN_WARNING = {
  type: 'DiagridPlaintextApiToken',
  code: 'DIAGRID_PLAINTEXT_API_TOKEN',
} as const;

/** The same, for a key set that could not be fetched at build time. */
const JWKS_WARM_FAILED_WARNING = {
  type: 'DiagridIdentityJwksWarmFailed',
  code: 'DIAGRID_IDENTITY_JWKS_WARM_FAILED',
} as const;

/**
 * Said out loud when a discovery source fails, rather than at debug level.
 *
 * A source that was configured and lost must not be silent: discovery falls
 * through to the environment, and the app then verifies against whatever issuer
 * happens to be exported there.
 */
const DISCOVERY_FAILED_MESSAGE = (url: string, error: unknown): string =>
  `identity discovery via ${url} failed (${failureDetail(error)}); ` +
  'trying the next source';

/**
 * Said out loud when the key set could not be pre-fetched.
 *
 * The build still succeeds — a sidecar that is still coming up must not stop
 * the app from starting — but an endpoint that never answers turns every
 * request into a 503, and an operator needs one line saying which endpoint.
 */
const JWKS_WARM_FAILED_MESSAGE = (jwksUri: string): string =>
  `identity JWKS warm-up via ${jwksUri} failed; verification will retry on ` +
  'the first request, and every request fails 503 until it succeeds';

/** Said out loud when the API token would leave the machine in the clear. */
const PLAINTEXT_API_TOKEN_MESSAGE = (endpoint: string): string =>
  `${DAPR_API_TOKEN_ENV} will be sent in clear text to non-https endpoint ` +
  `${endpoint}. It is sent anyway, because a self-hosted sidecar on plain ` +
  'http is a valid setup; use an https endpoint to stop advertising it.';

/**
 * Coordinates once discovery has settled every field: the resolved triple.
 *
 * Three required strings, where the caller's *input* is the all-optional
 * {@link BuildVerifierOptions}.
 *
 * Not part of the package's public API — no exported signature accepts or
 * returns one. It is exported from this module, and only from it, so that
 * {@link resolveCoordinates} can be asserted on directly.
 */
export interface IdentityCoordinates {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly audience: string;
}

/** The `identity` block of the sidecar's `/v1.0/metadata` response. */
interface MetadataIdentityBlock {
  readonly issuer?: string;
  /** Snake-cased on the wire; this is the sidecar's spelling, not ours. */
  readonly jwks_uri?: string;
  readonly audience?: string;
}

interface MetadataResponse {
  readonly identity?: MetadataIdentityBlock;
}

/**
 * The slice of a verifier the middleware depends on.
 *
 * Declaring it structurally keeps the middleware testable without a JWKS
 * endpoint: a test injects a fake.
 */
export interface TokenVerifier {
  /**
   * Verify signature and claims, returning the decoded payload.
   *
   * @throws {VerifierNotReadyError} key material unavailable.
   * @throws {TokenVerificationError} any verification failure.
   */
  verify(rawToken: string): Promise<TokenClaims>;
}

/**
 * What a caller may pin instead of letting discovery find it.
 *
 * Options rather than coordinates: every field is optional, and
 * `allowInsecureJwks` is a policy flag rather than a coordinate at all. The
 * resolved triple discovery produces is {@link IdentityCoordinates}.
 */
export interface BuildVerifierOptions {
  readonly issuer?: string;
  readonly audience?: string;
  readonly jwksUri?: string;
  /** See `OAuthConfig.allowInsecureJwks`. `false` when omitted. */
  readonly allowInsecureJwks?: boolean;
}

/** A key resolver that may, or may not, be able to re-fetch its key set. */
type Reloadable = JWTVerifyGetKey & { reload?: () => Promise<void> };

export interface JwksVerifierOptions {
  readonly issuer: string;
  readonly jwksUri: string;
  /** Expected `aud`. When empty, the audience claim is not checked at all. */
  readonly audience?: string;
  /**
   * Pre-built key resolver. Injected by tests; production leaves it unset so
   * the verifier builds a cached remote JWKS set from
   * {@link JwksVerifierOptions.jwksUri}.
   */
  readonly keys?: JWTVerifyGetKey;
  /** See `OAuthConfig.allowInsecureJwks`. `false` when omitted. */
  readonly allowInsecureJwks?: boolean;
}

/**
 * Fetches a JWKS over HTTPS, caches the keys, and verifies dp-Sentry JWTs.
 *
 * Safe to share across concurrent requests: the cached key set lives inside
 * `jose`'s remote JWKS resolver, which serialises its own refreshes.
 *
 * A token with more than one defect is refused on the first check that fails,
 * and the order that decides which `oauth.*` code it gets is `jose`'s: the
 * required claims, then `iss`, then `aud`, then `exp` — so an expired token
 * from the wrong issuer reports `oauth.invalid_issuer`, not `oauth.expired`.
 * Either way it is a 401. `tests/core/identity/verifier.test.ts` pins the order
 * so that it cannot drift unnoticed.
 *
 * @throws {IdentityNotConfiguredError} the JWKS URI is plaintext on a routable
 * host and `allowInsecureJwks` was not set.
 */
export class JwksVerifier implements TokenVerifier {
  readonly #issuer: string;
  readonly #jwksUri: string;
  readonly #audience: string;
  #keys: JWTVerifyGetKey | undefined;

  constructor(options: JwksVerifierOptions) {
    assertSecureJwksUri(options.jwksUri, options.allowInsecureJwks ?? false);
    this.#issuer = options.issuer;
    this.#jwksUri = options.jwksUri;
    this.#audience = options.audience ?? '';
    this.#keys = options.keys;
  }

  /**
   * Eagerly fetch the JWKS so the first verified request does not wait on it.
   *
   * Best-effort by design: a sidecar that is still coming up must not stop the
   * app from starting, and the next `verify` retries the fetch anyway. A
   * failure is said out loud rather than handed back, because there is nothing
   * for a caller to do about it and what an operator needs is a line naming the
   * endpoint whose absence turns every request into a 503.
   */
  async warm(): Promise<void> {
    try {
      // `reload` is on `jose`'s remote resolver but not on the bare
      // `JWTVerifyGetKey` an injected resolver satisfies, so warming a
      // verifier a test built by hand is a no-op rather than a crash.
      const keys: Reloadable = this.#resolveKeys();
      if (typeof keys.reload === 'function') {
        await keys.reload();
      }
    } catch {
      process.emitWarning(
        JWKS_WARM_FAILED_MESSAGE(this.#jwksUri),
        JWKS_WARM_FAILED_WARNING
      );
    }
  }

  async verify(rawToken: string): Promise<TokenClaims> {
    let keys: JWTVerifyGetKey;
    try {
      keys = this.#resolveKeys();
    } catch (error: unknown) {
      throw new VerifierNotReadyError(describe(error));
    }

    const options: JWTVerifyOptions = {
      algorithms: [...ALLOWED_ALGORITHMS],
      clockTolerance: CLOCK_SKEW_SECONDS,
      requiredClaims: [...REQUIRED_CLAIMS],
      // Conditional because an unconfigured audience must mean "do not check
      // `aud`", not "require `aud` to be the empty string".
      ...(this.#issuer ? { issuer: this.#issuer } : {}),
      ...(this.#audience ? { audience: this.#audience } : {}),
    };

    try {
      const { payload } = await jwtVerify(rawToken, keys, options);
      return payload;
    } catch (error: unknown) {
      throw toIdentityError(error);
    }
  }

  /**
   * The key resolver, built once.
   *
   * `createRemoteJWKSet` does not fetch anything here — it returns a resolver
   * that fetches on first use and then honours its own cache — so building it
   * lazily costs nothing and constructing a verifier never blocks.
   */
  #resolveKeys(): JWTVerifyGetKey {
    this.#keys ??= createRemoteJWKSet(new URL(this.#jwksUri), {
      cacheMaxAge: JWKS_CACHE_LIFETIME_SECONDS * MILLISECONDS_PER_SECOND,
    });
    return this.#keys;
  }
}

/**
 * Build a verifier from explicit config, sidecar metadata, or the environment.
 *
 * Precedence, highest first: explicit `issuer` + `jwksUri` > the local
 * `/v1.0/metadata` > the remote `/v1.0/metadata` > `DIAGRID_DP_SENTRY_ISSUER`.
 * A single explicit field narrows whichever source answers rather than
 * replacing it, so pinning only an `audience` still lets discovery find the
 * issuer, and pinning only an `issuer` is enough on its own — the JWKS URI is
 * then derived as issuer + `/jwks.json`.
 *
 * Local before remote is deliberate: a deployed in-cluster app must keep
 * answering from the loopback call rather than paying for a network round trip
 * on every cold start.
 *
 * @throws {IdentityNotConfiguredError} nothing supplied an issuer, or the
 * resolved JWKS URI is unusable, plaintext on a routable host, or not http(s).
 */
export async function buildVerifier(
  options: BuildVerifierOptions = {}
): Promise<JwksVerifier> {
  const coordinates = await resolveCoordinates(options);
  const verifier = new JwksVerifier({
    ...coordinates,
    allowInsecureJwks: options.allowInsecureJwks ?? false,
  });
  await verifier.warm();
  return verifier;
}

/**
 * Resolve the coordinates a verifier will be built from.
 *
 * Split out of {@link buildVerifier} so that the resolution rules can be
 * asserted without a JWKS endpoint, since a built verifier exposes none of the
 * three values it settled. Not re-exported from the package entry point: a
 * caller gets a verifier, never a triple.
 *
 * @throws {IdentityNotConfiguredError} nothing supplied an issuer.
 */
export async function resolveCoordinates(
  options: BuildVerifierOptions = {}
): Promise<IdentityCoordinates> {
  const { issuer, audience, jwksUri } = options;

  // Nothing left to discover once both halves are pinned, and probing anyway
  // would cost every such app a wasted round trip on its first request.
  //
  // `??` rather than `||` between the sources, unlike the field resolution
  // below: each source answers with coordinates or with `undefined`, and
  // short-circuiting is what keeps the remote probe from running when the local
  // sidecar has already answered.
  const discovered =
    issuer && jwksUri
      ? undefined
      : ((await discoverFromMetadata()) ??
        (await discoverFromRemote()) ??
        discoverFromEnv());

  // `||`, not `??`: `??` would pin the verifier to whatever
  // `issuer: process.env.ISSUER ?? ''` produced, and an issuer or audience of
  // `''` disables that claim's check outright in `verify`.
  //
  // Trimmed once, here, so that the issuer the verifier compares `iss` against
  // and the JWKS URI derived from it come from the same value. A real issuer
  // signs tokens whose `iss` carries no trailing slash, so an issuer pinned as
  // `https://sentry.acme/` would otherwise reject every token it ever minted.
  const resolvedIssuer = trimTrailingSlashes(
    issuer || discovered?.issuer || ''
  );
  const resolvedAudience = audience || discovered?.audience || '';

  // Three steps, in this order, and the order is the contract: explicit wins;
  // then a discovered value, but only when the source that advertised it is the
  // issuer that was actually resolved; then the derived default.
  //
  // Both halves are load-bearing. Taking the derived value first would discard
  // a `jwks_uri` a sidecar publishes away from its issuer and point the verifier
  // at an endpoint that need not exist. Taking a discovered value without the
  // issuer comparison would verify a pinned issuer's tokens against a foreign
  // issuer's key set, so a token minted by the advertised issuer and *claiming*
  // the pinned one would verify.
  let resolvedJwksUri = jwksUri || '';
  // Trimmed on both sides of the comparison because `resolvedIssuer` is: a
  // sidecar advertising `https://sentry.acme/` is advertising for the issuer a
  // caller pinned as `https://sentry.acme`.
  if (
    !resolvedJwksUri &&
    discovered &&
    trimTrailingSlashes(discovered.issuer) === resolvedIssuer
  ) {
    resolvedJwksUri = discovered.jwksUri;
  }
  if (!resolvedJwksUri && resolvedIssuer) {
    resolvedJwksUri = defaultJwksUri(resolvedIssuer);
  }

  if (!resolvedIssuer || !resolvedJwksUri) {
    throw new IdentityNotConfiguredError(CANNOT_DISCOVER_MESSAGE);
  }

  return {
    issuer: resolvedIssuer,
    jwksUri: resolvedJwksUri,
    audience: resolvedAudience,
  };
}

/**
 * A verifier built once, on first use, and rebuilt after a failed attempt.
 *
 * Shared by both framework adapters. Caching the *promise* rather than the
 * verifier is what stops a burst of concurrent first requests from each
 * probing the metadata endpoint; dropping it again on failure is what stops a
 * sidecar that was briefly unreachable from poisoning the process for good.
 */
export function lazyVerifier(
  options: BuildVerifierOptions,
  injected?: TokenVerifier
): () => Promise<TokenVerifier> {
  if (injected) {
    const ready = Promise.resolve(injected);
    return () => ready;
  }

  let pending: Promise<TokenVerifier> | undefined;
  return () => {
    pending ??= buildVerifier(options).catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

/** Probe `http://127.0.0.1:$PORT/v1.0/metadata` for the identity block. */
async function discoverFromMetadata(): Promise<
  IdentityCoordinates | undefined
> {
  // `||` for the same reason as in `buildVerifier`: a chart that templates
  // `CATALYST_DAPR_HTTP_PORT` unconditionally and leaves it blank must fall
  // through to Dapr's own variable.
  const port =
    process.env[CATALYST_DAPR_HTTP_PORT_ENV] || process.env[DAPR_HTTP_PORT_ENV];
  if (!port) {
    return undefined;
  }
  return probeMetadata(`http://127.0.0.1:${port}${METADATA_PATH}`, {});
}

/**
 * Probe a remote sidecar's `/v1.0/metadata` for the identity block.
 *
 * The source `diagrid dev run` needs: the app runs on the developer's machine
 * against a Catalyst-hosted sidecar, so nothing is listening on loopback.
 */
async function discoverFromRemote(): Promise<IdentityCoordinates | undefined> {
  // An endpoint templated into the environment and left blank is an absent
  // source, not an origin of zero length.
  const endpoint = trimTrailingSlashes(
    process.env[DAPR_HTTP_ENDPOINT_ENV] || ''
  );
  if (!endpoint) {
    // Not a failure and so deliberately silent: an app with no remote sidecar
    // has not misconfigured one.
    return undefined;
  }

  const headers: Record<string, string> = {};
  const token = process.env[DAPR_API_TOKEN_ENV] || '';
  if (token) {
    if (!endpoint.startsWith(`${HTTPS_PROTOCOL}//`)) {
      // Warned rather than refused, and still sent: a self-hosted sidecar on
      // plain http is a valid setup, and refusing to look would strand it with
      // no identity coordinates at all.
      process.emitWarning(
        PLAINTEXT_API_TOKEN_MESSAGE(endpoint),
        PLAINTEXT_API_TOKEN_WARNING
      );
    }
    headers[API_TOKEN_HEADER] = token;
  }
  return probeMetadata(`${endpoint}${METADATA_PATH}`, headers);
}

/**
 * Fetch one `/v1.0/metadata` document and read the identity block out of it.
 *
 * Shared by the local and the remote source so the two cannot drift: one
 * timeout, one failure warning, one reading of the body.
 */
async function probeMetadata(
  url: string,
  headers: Record<string, string>
): Promise<IdentityCoordinates | undefined> {
  try {
    const response = await fetch(url, {
      headers,
      // Discovery is on the cold-start path; an unresponsive sidecar must fail
      // over to the next source rather than hang the first request.
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`metadata endpoint answered ${response.status}`);
    }
    return coordinatesFromIdentity(await response.json());
  } catch (error: unknown) {
    // Every failure mode here — no sidecar, a non-JSON body, a timeout — means
    // the same thing to the caller: this source has no answer, try the next.
    // Said out loud, because a source that was configured and lost is the one
    // thing discovery must not lose quietly.
    process.emitWarning(
      DISCOVERY_FAILED_MESSAGE(url, error),
      DISCOVERY_FAILED_WARNING
    );
    return undefined;
  }
}

/**
 * Read the identity block out of a `/v1.0/metadata` response body.
 *
 * A body that is not the expected shape, or that carries no issuer, is no
 * discovery rather than an error: the sidecar answered, it just did not answer
 * this question.
 */
function coordinatesFromIdentity(
  body: unknown
): IdentityCoordinates | undefined {
  const identity = (body as MetadataResponse | null | undefined)?.identity;
  const issuer = stringField(identity?.issuer);
  if (!issuer) {
    return undefined;
  }
  return {
    issuer,
    jwksUri: stringField(identity?.jwks_uri) || defaultJwksUri(issuer),
    audience: stringField(identity?.audience),
  };
}

/**
 * A field of the metadata body as a string, or `''` if it is anything else.
 *
 * The response is untrusted input whatever {@link MetadataIdentityBlock} says
 * about it, and a numeric `jwks_uri` taken at face value reaches `new URL` as
 * a number and turns every request into a 503.
 */
function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The key set an issuer is assumed to publish when it advertises none.
 *
 * The trailing-slash trim is the whole reason this is a function: an issuer of
 * `https://sentry.acme/` concatenated naively yields
 * `https://sentry.acme//jwks.json`, and every request after that is a 503. It
 * is trimmed here as well as in {@link resolveCoordinates}, because discovery
 * derives a JWKS URI from an issuer it has not resolved yet.
 */
function defaultJwksUri(issuer: string): string {
  return `${trimTrailingSlashes(issuer)}${JWKS_PATH}`;
}

/**
 * An endpoint without the trailing slashes that must not reach a path.
 *
 * Scanned rather than matched with `/\/+$/`: that pattern backtracks on an
 * endpoint of many slashes, and the value comes from configuration or from a
 * sidecar response.
 */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === SLASH_CHAR_CODE) {
    end -= 1;
  }

  return value.slice(0, end);
}

/**
 * Refuse a key set that cannot be fetched, or that would be fetched in the clear.
 *
 * The JWKS is the whole root of trust: an on-path attacker who rewrites a
 * plaintext response substitutes his own keys, and every signature check
 * afterwards confirms his signature rather than dp-Sentry's. Loopback is exempt
 * because that is where the local sidecar publishes its keys.
 *
 * Three refusals, all of them the not-configured failure the middleware answers
 * 503 `oauth.not_configured` to, and all at build time rather than per request:
 *
 * - A URI that will not parse: a configuration error, not a downgrade.
 * - A scheme that is neither http nor https. `allowInsecureJwks` does *not*
 *   reach these: opting into plaintext says nothing about reading signing keys
 *   off a local filesystem.
 * - Plain http on a routable host without `allowInsecureJwks`.
 */
function assertSecureJwksUri(jwksUri: string, allowInsecure: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(jwksUri);
  } catch {
    throw new IdentityNotConfiguredError(UNUSABLE_JWKS_MESSAGE(jwksUri));
  }

  if (parsed.protocol === HTTPS_PROTOCOL || isLoopbackHost(parsed.hostname)) {
    return;
  }

  if (parsed.protocol !== HTTP_PROTOCOL) {
    throw new IdentityNotConfiguredError(
      UNSUPPORTED_JWKS_SCHEME_MESSAGE(jwksUri)
    );
  }

  if (allowInsecure) {
    return;
  }

  throw new IdentityNotConfiguredError(INSECURE_JWKS_MESSAGE(jwksUri));
}

/**
 * Whether `hostname`, as `URL` reports it, can only be this machine.
 *
 * The address is *parsed* rather than prefix-matched, which is the whole point:
 * `hostname.startsWith('127.')` also accepts `127.evil.example` and
 * `127.0.0.1.attacker.example`, ordinary DNS names anyone can register and
 * point anywhere, and accepting them hands an attacker the plaintext key set
 * this check exists to refuse. `isIP` reports version 0 for a DNS name, which
 * is therefore never loopback.
 */
function isLoopbackHost(hostname: string): boolean {
  if (LOOPBACK_HOSTNAMES.includes(hostname)) {
    return true;
  }

  // `URL` brackets an IPv6 host; `isIP` wants it bare.
  const address =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;

  switch (isIP(address)) {
    case IPV4:
      // The whole of `127.0.0.0/8`, not just `127.0.0.1`.
      return address.split('.')[0] === LOOPBACK_IPV4_FIRST_OCTET;
    case IPV6:
      return address === LOOPBACK_IPV6;
    default:
      return false;
  }
}

/** The last discovery source: the issuer and audience environment overrides. */
function discoverFromEnv(): IdentityCoordinates | undefined {
  const issuer = process.env[DP_SENTRY_ISSUER_ENV] || '';
  if (!issuer) {
    return undefined;
  }
  return {
    issuer,
    jwksUri: defaultJwksUri(issuer),
    audience: process.env[DP_SENTRY_AUDIENCE_ENV] || '',
  };
}

/**
 * Map a `jose` failure onto this module's error vocabulary.
 *
 * Matched on `error.code` rather than `instanceof`, because matching on the
 * code survives the case a class check does not: two copies of `jose` in one
 * dependency graph, where the thrown error is a real `JWTExpired` from a
 * different realm and every `instanceof` silently answers `false` — turning an
 * expired token into a 503.
 */
function toIdentityError(error: unknown): Error {
  const code = errorCode(error);
  const message = describe(error);

  switch (code) {
    case 'ERR_JWT_EXPIRED':
      return new TokenVerificationError(
        OAuthErrorCodes.Expired,
        'token has expired'
      );

    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      return claimValidationError(error, message);

    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return new TokenVerificationError(
        OAuthErrorCodes.InvalidSignature,
        'signature verification failed'
      );

    // Not a JWS at all: garbage, a truncated token, a JSON body pasted into
    // the header.
    case 'ERR_JWS_INVALID':
    case 'ERR_JWT_INVALID':
      return new TokenVerificationError(OAuthErrorCodes.DecodeError, message);

    // The key material is the problem, not the token — the caller cannot fix
    // it by re-authenticating, so this is a 503 rather than a 401.
    case 'ERR_JWKS_NO_MATCHING_KEY':
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
    case 'ERR_JWKS_TIMEOUT':
    case 'ERR_JWKS_INVALID':
    case 'ERR_JWK_INVALID':
      return new VerifierNotReadyError(message);

    default:
      // A coded JOSE failure this table does not name — an `alg` outside the
      // allowlist above all else — is a rejected token.
      if (code?.startsWith('ERR_')) {
        return new TokenVerificationError(
          OAuthErrorCodes.InvalidToken,
          message
        );
      }
      // Anything uncoded that escapes `jwtVerify` came from fetching the JWKS
      // — a refused connection, a DNS failure, an aborted request — which is
      // the same "no key material" condition as the JWKS codes above.
      return new VerifierNotReadyError(message);
  }
}

/** Split `jose`'s one claim-validation error across three `oauth.*` codes. */
function claimValidationError(
  error: unknown,
  message: string
): TokenVerificationError {
  const { claim, reason } = claimFailure(error);

  // A claim that is absent rather than wrong: not an issuer or audience
  // mismatch, so it lands in the same catch-all as any other invalid token.
  if (reason === 'missing') {
    return new TokenVerificationError(OAuthErrorCodes.InvalidToken, message);
  }
  if (claim === 'iss') {
    return new TokenVerificationError(
      OAuthErrorCodes.InvalidIssuer,
      'issuer mismatch'
    );
  }
  if (claim === 'aud') {
    return new TokenVerificationError(
      OAuthErrorCodes.InvalidAudience,
      'audience mismatch'
    );
  }
  return new TokenVerificationError(OAuthErrorCodes.InvalidToken, message);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function claimFailure(error: unknown): {
  claim: string | undefined;
  reason: string | undefined;
} {
  const failure = error as { claim?: unknown; reason?: unknown } | null;
  return {
    claim: typeof failure?.claim === 'string' ? failure.claim : undefined,
    reason: typeof failure?.reason === 'string' ? failure.reason : undefined,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `Name: message`, the shape a lost probe is logged with.
 *
 * The class name earns its place in the line: `TypeError: fetch failed` and
 * `TimeoutError: The operation was aborted` are different operator problems,
 * and the messages alone do not say which.
 */
function failureDetail(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Verification and coordinate resolution, against a real keypair.
 *
 * The algorithm-allowlist cases earn their place above all the others: "the
 * token is rejected when its `alg` is not ours" is the single assertion that
 * stops the classic JWT bypass.
 */

import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  ALLOWED_ALGORITHMS,
  CATALYST_DAPR_HTTP_PORT_ENV,
  CLOCK_SKEW_SECONDS,
  DAPR_HTTP_PORT_ENV,
  DP_SENTRY_AUDIENCE_ENV,
  DP_SENTRY_ISSUER_ENV,
  IdentityNotConfiguredError,
  JWKS_CACHE_LIFETIME_SECONDS,
  JwksVerifier,
  REQUIRED_CLAIMS,
  TokenVerificationError,
  VerifierNotReadyError,
  buildVerifier,
} from '@diagrid/agent-core';

// `resolveCoordinates` is module-internal — the barrel advertises
// `buildVerifier`, which hands back a verifier and exposes none of the three
// values it settled — so the discovery cases reach it by path. Asserting the
// resolved triple is what keeps those cases off a JWKS endpoint.
import { resolveCoordinates } from '../../../packages/core/src/identity/verifier';

import {
  epochSeconds,
  fixtureKeyResolver,
  generateFixtureKeypair,
  jwksBody,
  signHs256Token,
  signToken,
  unsecuredToken,
  validClaims,
  type Keypair,
} from '../../fixtures/identity';

const ISSUER = 'https://oidc.example.com';
const JWKS_URI = 'https://oidc.example.com/jwks.json';
/** Well-formed, and nothing behind it: `.invalid` never resolves (RFC 2606). */
const UNREACHABLE_JWKS = 'https://oidc.invalid/jwks.json';
const METADATA_PORT = '3500';

let keys: Keypair;
/** A second keypair, so "signed by the wrong key" is a real wrong key. */
let otherKeys: Keypair;

beforeAll(async () => {
  [keys, otherKeys] = await Promise.all([
    generateFixtureKeypair(),
    generateFixtureKeypair(),
  ]);
});

function verifierFor(
  publicKey: CryptoKey,
  overrides: { issuer?: string; audience?: string } = {}
): JwksVerifier {
  return new JwksVerifier({
    issuer: overrides.issuer ?? ISSUER,
    jwksUri: JWKS_URI,
    ...(overrides.audience === undefined
      ? {}
      : { audience: overrides.audience }),
    keys: fixtureKeyResolver(publicKey),
  });
}

/** Every URL a stubbed `fetch` was asked for. */
function probedUrls(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

/** The `process.emitWarning` type a failed JWKS warm-up carries. */
const JWKS_WARM_FAILED_WARNING = 'DiagridIdentityJwksWarmFailed';

/**
 * The warnings of interest emitted while `run` was in flight.
 *
 * Filtered by name because `process.emitWarning` dispatches on a later tick,
 * so an unfiltered capture also collects whatever another case in this worker
 * emitted just before the listener went on.
 */
async function warningsDuring(run: () => Promise<unknown>): Promise<Error[]> {
  const seen: Error[] = [];
  const listener = (warning: Error): void => {
    if (warning.name === JWKS_WARM_FAILED_WARNING) {
      seen.push(warning);
    }
  };
  process.on('warning', listener);
  try {
    await run().catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('warning', listener);
  }
  return seen;
}

/** The `oauth.*` code a rejected token reports, or a readable failure. */
async function codeOf(verify: Promise<unknown>): Promise<string> {
  try {
    await verify;
  } catch (error: unknown) {
    if (error instanceof TokenVerificationError) return error.code;
    return `unexpected: ${String(error)}`;
  }
  return 'unexpected: token was accepted';
}

describe('JwksVerifier contract constants', () => {
  it('matches the reference SDK verbatim', () => {
    // These four are the cross-SDK wire contract, so a change to any of them
    // is a deliberate one.
    expect(CLOCK_SKEW_SECONDS).toBe(120);
    expect(JWKS_CACHE_LIFETIME_SECONDS).toBe(300);
    expect(ALLOWED_ALGORITHMS).toEqual(['RS256', 'ES256']);
    expect(REQUIRED_CLAIMS).toEqual(['exp', 'iss', 'sub']);
  });
});

describe('JwksVerifier public surface', () => {
  it('exposes verification, and not the coordinates it resolved', () => {
    // No SDK publishes an accessor for the resolved triple: a getter here
    // would invite app code that reads `verifier.issuer` and has no equivalent
    // anywhere else. `resolveCoordinates` is what this suite reads instead.
    const verifier = verifierFor(keys.publicKey);

    const surface = [
      ...new Set([
        ...Object.getOwnPropertyNames(JwksVerifier.prototype),
        ...Object.keys(verifier),
      ]),
    ].sort();

    expect(surface).toEqual(['constructor', 'verify', 'warm']);
  });
});

describe('JwksVerifier.verify', () => {
  it('accepts a correctly signed token', async () => {
    const token = await signToken(keys.privateKey, validClaims());

    const claims = await verifierFor(keys.publicKey).verify(token);

    expect(claims.sub).toBe('alice@example.com');
    expect(claims.iss).toBe(ISSUER);
  });

  it('rejects an expired token', async () => {
    const token = await signToken(
      keys.privateKey,
      validClaims({ exp: epochSeconds(-3600), iat: epochSeconds(-7200) })
    );

    await expect(
      codeOf(verifierFor(keys.publicKey).verify(token))
    ).resolves.toBe('oauth.expired');
  });

  it('accepts a token that expired inside the clock-skew window', async () => {
    // The other half of the 120s constant: a fleet with slightly divergent
    // clocks must not reject its own freshly minted tokens.
    const token = await signToken(
      keys.privateKey,
      validClaims({ exp: epochSeconds(-(CLOCK_SKEW_SECONDS - 30)) })
    );

    await expect(
      verifierFor(keys.publicKey).verify(token)
    ).resolves.toMatchObject({ sub: 'alice@example.com' });
  });

  it('rejects a token from the wrong issuer', async () => {
    const token = await signToken(
      keys.privateKey,
      validClaims({ iss: 'https://wrong-issuer.com' })
    );

    await expect(
      codeOf(verifierFor(keys.publicKey).verify(token))
    ).resolves.toBe('oauth.invalid_issuer');
  });

  it('refuses a doubly-defective token on the first check that fails', async () => {
    // Expired *and* from the wrong issuer. Which `oauth.*` code that earns is
    // the crypto library's claim-check order — required claims, then `iss`,
    // then `aud`, then `exp` — and either way the token is refused with a 401.
    // This case records that order, because a change to it is a wire change.
    const token = await signToken(
      keys.privateKey,
      validClaims({
        iss: 'https://wrong-issuer.com',
        exp: epochSeconds(-3600),
        iat: epochSeconds(-7200),
      })
    );

    await expect(
      codeOf(verifierFor(keys.publicKey).verify(token))
    ).resolves.toBe('oauth.invalid_issuer');
  });

  it('rejects a token for the wrong audience', async () => {
    const token = await signToken(
      keys.privateKey,
      validClaims({ aud: 'some-other-app' })
    );

    const verifier = verifierFor(keys.publicKey, { audience: 'this-app' });

    await expect(codeOf(verifier.verify(token))).resolves.toBe(
      'oauth.invalid_audience'
    );
  });

  it('ignores the audience claim when no audience is configured', async () => {
    // An unconfigured audience means `aud` is not checked at all, rather than
    // required to be empty.
    const token = await signToken(
      keys.privateKey,
      validClaims({ aud: 'some-other-app' })
    );

    await expect(
      verifierFor(keys.publicKey).verify(token)
    ).resolves.toMatchObject({ aud: 'some-other-app' });
  });

  it('rejects a token signed by the wrong key', async () => {
    const token = await signToken(otherKeys.privateKey, validClaims());

    await expect(
      codeOf(verifierFor(keys.publicKey).verify(token))
    ).resolves.toBe('oauth.invalid_signature');
  });

  it('rejects an HS256 token', async () => {
    // Algorithm confusion: a token signed with the public key as an HMAC
    // secret. `jose` refuses it on the allowlist, before any key is consulted.
    const token = await signHs256Token(validClaims());

    await expect(
      codeOf(verifierFor(keys.publicKey).verify(token))
    ).resolves.toBe('oauth.invalid_token');
  });

  it('rejects an alg:none token', async () => {
    const token = unsecuredToken(validClaims());

    await expect(
      verifierFor(keys.publicKey).verify(token)
    ).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('rejects a token with no signature segment', async () => {
    const signed = await signToken(keys.privateKey, validClaims());
    const unsigned = `${signed.split('.').slice(0, 2).join('.')}.`;

    await expect(
      verifierFor(keys.publicKey).verify(unsigned)
    ).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('rejects a garbage token as a decode error', async () => {
    // A token that is not a JWS at all is a decode error the caller is told
    // about, never an unmapped failure that surfaces as a 500.
    await expect(
      codeOf(verifierFor(keys.publicKey).verify('not-a-jwt'))
    ).resolves.toBe('oauth.decode_error');
  });

  it('rejects a token missing a required claim', async () => {
    for (const claim of REQUIRED_CLAIMS) {
      const claims = validClaims();
      delete claims[claim];
      const token = await signToken(keys.privateKey, claims);

      await expect(
        codeOf(verifierFor(keys.publicKey).verify(token)),
        `a token with no "${claim}" must be refused`
      ).resolves.toBe('oauth.invalid_token');
    }
  });

  it('reports unreachable key material as not-ready, not as a bad token', async () => {
    // The distinction the status codes hang off: the caller cannot fix this
    // by re-authenticating, so it must not look like a rejected token.
    const verifier = new JwksVerifier({
      issuer: ISSUER,
      jwksUri: JWKS_URI,
      keys: () => Promise.reject(new Error('connect ECONNREFUSED')),
    });
    const token = await signToken(keys.privateKey, validClaims());

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(
      VerifierNotReadyError
    );
  });

  it('surfaces an unreachable JWKS endpoint as not-ready', async () => {
    // A well-formed https URI with nothing behind it: the key material is the
    // problem, not the configuration and not the credential presented.
    const verifier = new JwksVerifier({
      issuer: ISSUER,
      jwksUri: UNREACHABLE_JWKS,
    });
    const raw = await signToken(keys.privateKey, validClaims());

    await expect(verifier.verify(raw)).rejects.toBeInstanceOf(
      VerifierNotReadyError
    );
  });
});

describe('JwksVerifier.warm', () => {
  it('warns rather than throwing when the JWKS is unreachable', async () => {
    // There is nothing for a caller to do about a key set that is not up yet,
    // so the failure is said out loud rather than handed back.
    const verifier = new JwksVerifier({
      issuer: ISSUER,
      jwksUri: UNREACHABLE_JWKS,
    });

    const warnings = await warningsDuring(async () => {
      await expect(verifier.warm()).resolves.toBeUndefined();
    });

    expect(warnings.map((warning) => warning.message).join('\n')).toContain(
      UNREACHABLE_JWKS
    );
  });

  it('says out loud when buildVerifier could not pre-fetch the key set', async () => {
    // A key set that never loads answers 503 to every request. The build
    // still succeeds - a sidecar coming up must not stop the app - so the
    // warning is the only thing standing between that and silence.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')))
    );

    const warnings = await warningsDuring(() =>
      buildVerifier({ issuer: ISSUER, jwksUri: JWKS_URI })
    );

    expect(warnings.map((warning) => warning.name)).toContain(
      JWKS_WARM_FAILED_WARNING
    );
    expect(warnings.map((warning) => warning.message).join('\n')).toContain(
      JWKS_URI
    );
  });

  it('says nothing for an injected resolver that needs no fetch', async () => {
    const warnings = await warningsDuring(async () => {
      await expect(verifierFor(keys.publicKey).warm()).resolves.toBeUndefined();
    });

    expect(warnings).toEqual([]);
  });
});

describe('coordinate discovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /**
   * Answer `metadata` on the sidecar probe and refuse everything else.
   *
   * Refusing the rest is deliberate: it is what proves `buildVerifier` never
   * needs a reachable JWKS endpoint to return, and it keeps the suite off the
   * network.
   */
  function stubSidecar(body: unknown, ok = true): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL) => {
        if (String(input).includes('/v1.0/metadata')) {
          return Promise.resolve({
            ok,
            json: () => Promise.resolve(body),
          } as Response);
        }
        return Promise.reject(new Error('no JWKS endpoint in this test'));
      })
    );
  }

  it('reads the identity block from the sidecar metadata endpoint', async () => {
    vi.stubEnv(DAPR_HTTP_PORT_ENV, METADATA_PORT);
    stubSidecar({
      id: 'test-app',
      identity: {
        issuer: 'https://oidc.test.com/org/region',
        jwks_uri: 'https://oidc.test.com/org/region/jwks.json',
      },
    });

    const coordinates = await resolveCoordinates();

    expect(coordinates.issuer).toBe('https://oidc.test.com/org/region');
    expect(coordinates.jwksUri).toBe(
      'https://oidc.test.com/org/region/jwks.json'
    );
  });

  it('derives the JWKS URI from the issuer when the sidecar omits it', async () => {
    vi.stubEnv(DAPR_HTTP_PORT_ENV, METADATA_PORT);
    stubSidecar({ identity: { issuer: 'https://oidc.test.com/org/region' } });

    const coordinates = await resolveCoordinates();

    expect(coordinates.jwksUri).toBe(
      'https://oidc.test.com/org/region/jwks.json'
    );
  });

  it("prefers Catalyst's own sidecar port variable", async () => {
    vi.stubEnv(CATALYST_DAPR_HTTP_PORT_ENV, '4500');
    vi.stubEnv(DAPR_HTTP_PORT_ENV, METADATA_PORT);
    const probed: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL) => {
        probed.push(String(input));
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ identity: { issuer: ISSUER } }),
        } as Response);
      })
    );

    await buildVerifier();

    expect(probed[0]).toBe('http://127.0.0.1:4500/v1.0/metadata');
  });

  it('falls through to the environment when the sidecar has no identity block', async () => {
    vi.stubEnv(DAPR_HTTP_PORT_ENV, METADATA_PORT);
    vi.stubEnv(DP_SENTRY_ISSUER_ENV, 'https://oidc.test.com/org/region');
    vi.stubEnv(DP_SENTRY_AUDIENCE_ENV, 'agent-app');
    stubSidecar({ id: 'test-app' });

    const coordinates = await resolveCoordinates();

    expect(coordinates.issuer).toBe('https://oidc.test.com/org/region');
    expect(coordinates.jwksUri).toBe(
      'https://oidc.test.com/org/region/jwks.json'
    );
    expect(coordinates.audience).toBe('agent-app');
  });

  it('falls through to the environment when the sidecar probe fails', async () => {
    vi.stubEnv(DAPR_HTTP_PORT_ENV, METADATA_PORT);
    vi.stubEnv(DP_SENTRY_ISSUER_ENV, ISSUER);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')))
    );

    await expect(resolveCoordinates()).resolves.toMatchObject({
      issuer: ISSUER,
    });
  });

  it('ignores a non-2xx metadata response', async () => {
    vi.stubEnv(DAPR_HTTP_PORT_ENV, METADATA_PORT);
    stubSidecar({ identity: { issuer: ISSUER } }, false);

    await expect(buildVerifier()).rejects.toBeInstanceOf(
      IdentityNotConfiguredError
    );
  });

  it('skips the sidecar probe entirely when no port is set', async () => {
    vi.stubEnv(DP_SENTRY_ISSUER_ENV, ISSUER);
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network here')));
    vi.stubGlobal('fetch', fetchSpy);

    await buildVerifier();

    // Warming the JWKS is expected; probing a sidecar that was never
    // configured is not, and would cost every app without one a wasted
    // connection attempt on its first authenticated request.
    expect(probedUrls(fetchSpy)).not.toContainEqual(
      expect.stringContaining('/v1.0/metadata')
    );
  });
});

/**
 * The JWKS endpoint is the entire root of trust, so its transport is too.
 *
 * An attacker on the path of a plaintext key-set response substitutes his own
 * keys and thereafter mints credentials this app accepts — signature
 * verification then confirms his signature rather than dp-Sentry's. Loopback is
 * the one exemption, because that is where the local sidecar publishes its
 * keys; anything else costs an explicit `allowInsecureJwks`.
 */
describe('JWKS transport', () => {
  const INSECURE_ISSUER = 'http://oidc.example.com';
  const INSECURE_JWKS = 'http://oidc.example.com/jwks.json';

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('refuses a plaintext JWKS URI on a routable host', async () => {
    await expect(
      buildVerifier({ issuer: INSECURE_ISSUER, jwksUri: INSECURE_JWKS })
    ).rejects.toBeInstanceOf(IdentityNotConfiguredError);
  });

  it('refuses one discovered from the sidecar just as readily', async () => {
    // Discovery is not a trusted source of a scheme: a compromised or
    // misconfigured metadata endpoint must not be able to downgrade the app.
    vi.stubEnv(DAPR_HTTP_PORT_ENV, METADATA_PORT);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL) => {
        if (String(input).includes('/v1.0/metadata')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                identity: { issuer: INSECURE_ISSUER, jwks_uri: INSECURE_JWKS },
              }),
          } as Response);
        }
        return Promise.reject(new Error('no JWKS endpoint in this test'));
      })
    );

    await expect(buildVerifier()).rejects.toBeInstanceOf(
      IdentityNotConfiguredError
    );
  });

  it('allows plaintext on a loopback host', async () => {
    // `127.0.0.2` earns its place: the whole of `127.0.0.0/8` is loopback, so
    // anchoring the check must not narrow it to `127.0.0.1`.
    for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', '[::1]']) {
      const jwksUri = `http://${host}:3500/jwks.json`;

      await expect(
        buildVerifier({ issuer: `http://${host}:3500`, jwksUri }),
        `${host} is loopback`
      ).resolves.toBeInstanceOf(JwksVerifier);
    }
  });

  it('refuses a plaintext JWKS URI on a host that merely begins "127."', async () => {
    // The hole an unanchored `hostname.startsWith('127.')` left open. Both of
    // these are ordinary DNS names an attacker can register and point
    // anywhere, and the key set is the entire root of trust: a substituted
    // JWKS is a complete authentication bypass, not an eavesdropping risk.
    for (const host of ['127.evil.example', '127.0.0.1.attacker.example']) {
      await expect(
        buildVerifier({
          issuer: `http://${host}`,
          jwksUri: `http://${host}/jwks.json`,
        }),
        `${host} is a DNS name, not loopback`
      ).rejects.toBeInstanceOf(IdentityNotConfiguredError);
    }
  });

  it('allows plaintext anywhere once the app opts in', async () => {
    await expect(
      buildVerifier({
        issuer: INSECURE_ISSUER,
        jwksUri: INSECURE_JWKS,
        allowInsecureJwks: true,
      })
    ).resolves.toBeInstanceOf(JwksVerifier);
  });

  it('relaxes plain http only, never another scheme', async () => {
    // Opting into plaintext says nothing about loading signing keys off the
    // local filesystem, and the flag must not be readable as "skip the
    // transport check".
    for (const jwksUri of [
      'file:///etc/diagrid/jwks.json',
      'ftp://oidc.example.com/jwks.json',
    ]) {
      await expect(
        buildVerifier({
          issuer: INSECURE_ISSUER,
          jwksUri,
          allowInsecureJwks: true,
        }),
        `${jwksUri} is not http`
      ).rejects.toBeInstanceOf(IdentityNotConfiguredError);
    }
  });

  it('still accepts https without the flag', async () => {
    await expect(
      buildVerifier({ issuer: ISSUER, jwksUri: JWKS_URI })
    ).resolves.toBeInstanceOf(JwksVerifier);
  });

  it('reports an unparseable JWKS URI as misconfiguration, at build time', async () => {
    // A URI that will not parse is a configuration error, so it takes the
    // not-configured failure at build time rather than surfacing on every
    // request as 503 `oauth.verifier_unavailable`.
    expect(
      () => new JwksVerifier({ issuer: ISSUER, jwksUri: 'not a url' })
    ).toThrow(IdentityNotConfiguredError);

    await expect(
      buildVerifier({ issuer: ISSUER, jwksUri: 'not a url' })
    ).rejects.toBeInstanceOf(IdentityNotConfiguredError);
  });
});

describe('buildVerifier', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('uses explicit coordinates without probing anything', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('should not run')));
    vi.stubGlobal('fetch', fetchSpy);

    const coordinates = await resolveCoordinates({
      issuer: ISSUER,
      jwksUri: JWKS_URI,
    });

    expect(coordinates.issuer).toBe(ISSUER);
    expect(coordinates.jwksUri).toBe(JWKS_URI);
    expect(coordinates.audience).toBe('');
    // Warming is best-effort, so it may touch the network; discovery must not.
    expect(probedUrls(fetchSpy)).not.toContainEqual(
      expect.stringContaining('/v1.0/metadata')
    );
  });

  it('lets an explicit audience narrow discovered coordinates', async () => {
    vi.stubEnv(DP_SENTRY_ISSUER_ENV, ISSUER);
    vi.stubEnv(DP_SENTRY_AUDIENCE_ENV, 'discovered-audience');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no network in this test')))
    );

    const coordinates = await resolveCoordinates({
      audience: 'explicit-audience',
    });

    expect(coordinates.issuer).toBe(ISSUER);
    expect(coordinates.audience).toBe('explicit-audience');
  });

  it('refuses to build when nothing supplies an issuer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no network in this test')))
    );

    await expect(buildVerifier()).rejects.toThrow(/Cannot discover/);
  });

  it('builds from an explicit issuer alone, deriving the JWKS URI', async () => {
    // Pinning only an issuer is a supported configuration: with no discovery
    // source reachable the JWKS URI is derived as issuer + /jwks.json rather
    // than refused.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no network in this test')))
    );

    const coordinates = await resolveCoordinates({ issuer: ISSUER });

    expect(coordinates.issuer).toBe(ISSUER);
    expect(coordinates.jwksUri).toBe(JWKS_URI);
  });

  it('trims a trailing slash off the issuer, not just off the derivation', async () => {
    // Two failures, not one. `https://sentry.acme//jwks.json` is a 404 at
    // best, so every request after it is a 503; and the untrimmed issuer is
    // what `iss` is compared against, so — since a real issuer mints tokens
    // whose `iss` carries no trailing slash — it also refuses every valid token
    // with `oauth.invalid_issuer`.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no network in this test')))
    );

    const coordinates = await resolveCoordinates({ issuer: `${ISSUER}/` });

    expect(coordinates.issuer).toBe(ISSUER);
    expect(coordinates.jwksUri).toBe(JWKS_URI);
  });

  it('trims a trailing slash off an issuer read from the environment', async () => {
    // How an operator actually hits it: `DIAGRID_DP_SENTRY_ISSUER` copied out
    // of a browser's address bar, or templated with a trailing separator.
    vi.stubEnv(DP_SENTRY_ISSUER_ENV, `${ISSUER}//`);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no network in this test')))
    );

    const coordinates = await resolveCoordinates();

    expect(coordinates.issuer).toBe(ISSUER);
    expect(coordinates.jwksUri).toBe(JWKS_URI);
  });

  it('verifies a genuine token when the pinned issuer carried a slash', async () => {
    // The whole point of the trim, end to end and through the real
    // `buildVerifier`: the token is exactly what the issuer signs — `iss`
    // without a trailing slash — and the verifier was pinned with one. The
    // JWKS arrives over the stubbed `fetch` rather than an injected resolver,
    // so the URI the trim derived has to be the one that gets fetched too.
    const keySet = await jwksBody(keys.publicKey);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL) =>
        String(input) === JWKS_URI
          ? Promise.resolve({
              status: 200,
              ok: true,
              json: () => Promise.resolve(keySet),
            } as Response)
          : Promise.reject(new Error(`unexpected fetch of ${String(input)}`))
      )
    );

    const verifier = await buildVerifier({ issuer: `${ISSUER}/` });
    const token = await signToken(keys.privateKey, validClaims());

    await expect(verifier.verify(token)).resolves.toMatchObject({
      iss: ISSUER,
      sub: 'alice@example.com',
    });
  });

  it('ignores a JWKS URI advertised for a different issuer', async () => {
    // The guard that stops a pinned issuer being verified against a foreign
    // issuer's key set. Without it a token minted by the advertised issuer
    // and claiming the pinned one verifies, because the signature checks out
    // against the keys the sidecar pointed at.
    vi.stubEnv(DAPR_HTTP_PORT_ENV, METADATA_PORT);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL) => {
        if (String(input).includes('/v1.0/metadata')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                identity: {
                  issuer: 'https://other.acme',
                  jwks_uri: 'https://keys.other.acme/jwks',
                },
              }),
          } as Response);
        }
        return Promise.reject(new Error('no JWKS endpoint in this test'));
      })
    );

    const coordinates = await resolveCoordinates({ issuer: ISSUER });

    expect(coordinates.issuer).toBe(ISSUER);
    expect(coordinates.jwksUri).toBe(JWKS_URI);
  });

  it('adopts a JWKS URI advertised for the issuer it resolved', async () => {
    // The other half of the same rule: a sidecar that publishes its key set
    // away from its issuer must not be silently overridden by the derived
    // value, which need not exist.
    vi.stubEnv(DAPR_HTTP_PORT_ENV, METADATA_PORT);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL) => {
        if (String(input).includes('/v1.0/metadata')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                identity: {
                  issuer: ISSUER,
                  jwks_uri: 'https://keys.example.com/jwks',
                },
              }),
          } as Response);
        }
        return Promise.reject(new Error('no JWKS endpoint in this test'));
      })
    );

    const coordinates = await resolveCoordinates({ issuer: ISSUER });

    expect(coordinates.jwksUri).toBe('https://keys.example.com/jwks');
  });
});

/**
 * Empty strings are not "unset", and that is the whole hazard.
 *
 * A config assembled the way configs actually are — `issuer:
 * process.env.ISSUER ?? ''` — must fall through to discovery rather than pin
 * the verifier to an issuer of `''`, which {@link JwksVerifier.verify} then
 * reads as "do not check `iss` at all". Same for `audience` and the sidecar
 * port.
 */
describe('empty coordinates fall through to discovery', () => {
  const DISCOVERED_ISSUER = 'https://oidc.test.com/org/region';
  const DISCOVERED_JWKS = 'https://oidc.test.com/org/region/keys.json';
  const DISCOVERED_AUDIENCE = 'agent-app';

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** Answer the sidecar probe with a full identity block, and nothing else. */
  function stubSidecarIdentity(): ReturnType<typeof vi.fn> {
    const fetchSpy = vi.fn((input: string | URL) => {
      if (String(input).includes('/v1.0/metadata')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              identity: {
                issuer: DISCOVERED_ISSUER,
                jwks_uri: DISCOVERED_JWKS,
                audience: DISCOVERED_AUDIENCE,
              },
            }),
        } as Response);
      }
      return Promise.reject(new Error('no JWKS endpoint in this test'));
    });
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  }

  it('discovers the issuer when the caller passes an empty one', async () => {
    vi.stubEnv(DAPR_HTTP_PORT_ENV, METADATA_PORT);
    stubSidecarIdentity();

    const coordinates = await resolveCoordinates({ issuer: '' });

    // An issuer of `''` disables the `iss` check outright — the one thing a
    // verifier must never do silently.
    expect(coordinates.issuer).toBe(DISCOVERED_ISSUER);
  });

  it('discovers the audience when the caller passes an empty one', async () => {
    vi.stubEnv(DAPR_HTTP_PORT_ENV, METADATA_PORT);
    stubSidecarIdentity();

    const coordinates = await resolveCoordinates({ audience: '' });

    expect(coordinates.audience).toBe(DISCOVERED_AUDIENCE);
  });

  it('discovers the JWKS URI when the caller passes an empty one', async () => {
    vi.stubEnv(DAPR_HTTP_PORT_ENV, METADATA_PORT);
    stubSidecarIdentity();

    const coordinates = await resolveCoordinates({ jwksUri: '' });

    expect(coordinates.jwksUri).toBe(DISCOVERED_JWKS);
  });

  it("falls through an empty Catalyst port to Dapr's", async () => {
    // How an empty value gets there: a Helm chart that templates the variable
    // unconditionally and leaves it blank off Catalyst.
    vi.stubEnv(CATALYST_DAPR_HTTP_PORT_ENV, '');
    vi.stubEnv(DAPR_HTTP_PORT_ENV, METADATA_PORT);
    const fetchSpy = stubSidecarIdentity();

    const coordinates = await resolveCoordinates();

    expect(coordinates.issuer).toBe(DISCOVERED_ISSUER);
    expect(probedUrls(fetchSpy)).toContain(
      `http://127.0.0.1:${METADATA_PORT}/v1.0/metadata`
    );
  });

  it('derives the JWKS URI when the sidecar reports an empty one', async () => {
    vi.stubEnv(DAPR_HTTP_PORT_ENV, METADATA_PORT);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL) => {
        if (String(input).includes('/v1.0/metadata')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                identity: { issuer: DISCOVERED_ISSUER, jwks_uri: '' },
              }),
          } as Response);
        }
        return Promise.reject(new Error('no JWKS endpoint in this test'));
      })
    );

    const coordinates = await resolveCoordinates();

    // `new URL('')` throws, so an empty `jwks_uri` taken at face value turns
    // every request into a 503.
    expect(coordinates.jwksUri).toBe(`${DISCOVERED_ISSUER}/jwks.json`);
  });
});

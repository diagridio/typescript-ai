// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The remote sidecar discovery source.
 *
 * `diagrid dev run` runs the app on a developer's machine against a
 * Catalyst-hosted sidecar: nothing is listening on loopback, so the local probe
 * cannot answer. These cases pin the remote source that fills that gap, its
 * place in the precedence chain, and the two things it does with the API
 * token.
 *
 * Every endpoint here is a real `node:http` server on 127.0.0.1 — including
 * the issuers the fixtures publish, so that the best-effort JWKS warm-up a
 * resolved verifier performs stays on loopback too. The token-header cases
 * assert on what the server *received* rather than on what the client
 * believes it sent, which is the only version of that assertion worth having.
 */

import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DAPR_API_TOKEN_ENV,
  DAPR_HTTP_ENDPOINT_ENV,
  DAPR_HTTP_PORT_ENV,
  DP_SENTRY_ISSUER_ENV,
  IdentityNotConfiguredError,
  buildVerifier,
} from '@diagrid/agent-core';

// Reached by path: a built verifier exposes none of the coordinates it
// resolved, and what these cases are about is which source they came from.
import { resolveCoordinates } from '../../../packages/core/src/identity/verifier';

/** The sidecar's metadata path, spelled out rather than imported. */
const METADATA_PATH = '/v1.0/metadata';

/**
 * The token header, spelled out for the same reason.
 *
 * Both are wire contracts with the sidecar; importing the implementation's own
 * constants would only make these cases agree with a typo.
 */
const API_TOKEN_HEADER = 'dapr-api-token';

const API_TOKEN = 'diagrid://v1/org/prj/token';

const LOOPBACK_HOST = '127.0.0.1';

/** The `process.emitWarning` types the two discovery warnings carry. */
const DISCOVERY_FAILED_WARNING = 'DiagridIdentityDiscoveryFailed';
const PLAINTEXT_TOKEN_WARNING = 'DiagridPlaintextApiToken';
const DISCOVERY_WARNINGS: readonly string[] = [
  DISCOVERY_FAILED_WARNING,
  PLAINTEXT_TOKEN_WARNING,
];

/** One request as the server saw it. */
interface ReceivedRequest {
  readonly path: string;
  readonly apiToken: string | undefined;
}

interface MetadataServer {
  /** Origin with no trailing slash, e.g. `http://127.0.0.1:52431`. */
  readonly origin: string;
  /** Every request this server actually received, in arrival order. */
  readonly received: readonly ReceivedRequest[];
}

const servers: Server[] = [];

const loopbackOrigin = (port: number): string =>
  `http://${LOOPBACK_HOST}:${port}`;

function portOf(server: Server): number {
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('server is not listening on a TCP port');
  }
  return address.port;
}

/**
 * Serve `body(origin)` at `/v1.0/metadata` on an ephemeral loopback port.
 *
 * The body is built per request so a fixture can publish coordinates pointing
 * at this very server, whose port is not known until it is listening.
 * Everything other than the metadata path answers 404, which is what keeps a
 * JWKS warm-up from being handed a metadata document.
 */
async function startMetadataServer(
  body: (origin: string) => unknown
): Promise<MetadataServer> {
  const received: ReceivedRequest[] = [];
  const server = createServer((req, res) => {
    received.push({
      path: req.url ?? '/',
      apiToken: req.headers[API_TOKEN_HEADER] as string | undefined,
    });
    if (req.url !== METADATA_PATH) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body(loopbackOrigin(portOf(server)))));
  });
  servers.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  return { origin: loopbackOrigin(portOf(server)), received };
}

/**
 * A loopback port nothing is listening on.
 *
 * Bound and released rather than hard-coded: an arbitrary port number can
 * collide with whatever else the developer happens to be running, and
 * "unreachable" is the whole point of the cases that use it.
 */
async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const port = portOf(server);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return port;
}

/** A `/v1.0/metadata` body shaped the way the sidecar shapes it. */
const metadataBody = (identity: unknown): unknown => ({
  id: 'test-app',
  identity,
});

/** A sidecar that publishes coordinates served by itself. */
const selfPublishing = (origin: string): unknown =>
  metadataBody({ issuer: origin, jwks_uri: `${origin}/keys.json` });

/** The metadata requests `server` received, ignoring JWKS warm-up traffic. */
function metadataRequests(server: MetadataServer): ReceivedRequest[] {
  return server.received.filter((request) => request.path === METADATA_PATH);
}

/**
 * The *discovery* warnings emitted while `run` was in flight.
 *
 * Filtered to those two types on purpose, for two reasons.
 * `process.emitWarning` dispatches on a later tick, so an unfiltered capture
 * also collects whatever another case in this worker emitted just before the
 * listener went on. And every case here resolves coordinates that point at a
 * closed port, so the best-effort JWKS warm-up fails and warns in all of
 * them — a fact about the fixtures, not about discovery, and one that would
 * make `says nothing at all` assert nothing. That warning has its own case in
 * `./verifier.test.ts`.
 */
async function discoveryWarnings(
  run: () => Promise<unknown>
): Promise<Error[]> {
  const seen: Error[] = [];
  const listener = (warning: Error): void => {
    if (DISCOVERY_WARNINGS.includes(warning.name)) {
      seen.push(warning);
    }
  };
  process.on('warning', listener);
  try {
    // Swallowed: several of these cases are about what was logged on the way
    // to a build that could not resolve an issuer at all.
    await run().catch(() => undefined);
    // `process.emitWarning` dispatches on the next tick.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('warning', listener);
  }
  return seen;
}

const messagesOf = (warnings: readonly Error[]): string =>
  warnings.map((warning) => warning.message).join('\n');

const namesOf = (warnings: readonly Error[]): string[] =>
  warnings.map((warning) => warning.name);

/** A `fetch` that answers nothing, so a probe cannot leave this machine. */
function stubUnreachableFetch(): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(() => Promise.reject(new Error('no network here')));
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

/** Every URL a stubbed `fetch` was asked for. */
const probedUrls = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls.map((call) => String(call[0]));

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

describe('remote sidecar discovery', () => {
  it('reads the identity block a remote sidecar publishes', async () => {
    const sidecar = await startMetadataServer(selfPublishing);
    // A trailing slash on the endpoint must not produce `//v1.0/metadata`.
    vi.stubEnv(DAPR_HTTP_ENDPOINT_ENV, `${sidecar.origin}/`);

    const coordinates = await resolveCoordinates();

    expect(coordinates.issuer).toBe(sidecar.origin);
    expect(coordinates.jwksUri).toBe(`${sidecar.origin}/keys.json`);
    expect(metadataRequests(sidecar).map((request) => request.path)).toEqual([
      METADATA_PATH,
    ]);
  });

  it('probes nothing when no endpoint is configured', async () => {
    // `''` matters as much as unset: a chart that templates the variable
    // unconditionally and leaves it blank must not send discovery at a
    // zero-length origin.
    for (const endpoint of [undefined, '']) {
      vi.unstubAllEnvs();
      vi.stubEnv(
        DP_SENTRY_ISSUER_ENV,
        loopbackOrigin(await closedLoopbackPort())
      );
      if (endpoint !== undefined) {
        vi.stubEnv(DAPR_HTTP_ENDPOINT_ENV, endpoint);
      }
      const fetchSpy = stubUnreachableFetch();

      await buildVerifier();

      expect(
        probedUrls(fetchSpy),
        `endpoint ${JSON.stringify(endpoint)} must not be probed`
      ).not.toContainEqual(expect.stringContaining(METADATA_PATH));
    }
  });

  it('sends the API token to the sidecar that asked for it', async () => {
    const sidecar = await startMetadataServer(selfPublishing);
    vi.stubEnv(DAPR_HTTP_ENDPOINT_ENV, sidecar.origin);
    vi.stubEnv(DAPR_API_TOKEN_ENV, API_TOKEN);

    await buildVerifier();

    expect(metadataRequests(sidecar)[0]?.apiToken).toBe(API_TOKEN);
  });

  it('sends no token header when none is configured', async () => {
    const sidecar = await startMetadataServer(selfPublishing);
    vi.stubEnv(DAPR_HTTP_ENDPOINT_ENV, sidecar.origin);

    await buildVerifier();

    // Absent, not empty: a blank `dapr-api-token` is a token the sidecar can
    // reject rather than a request that never claimed to carry one.
    expect(metadataRequests(sidecar)[0]?.apiToken).toBeUndefined();
  });

  it('discovers nothing when the remote request fails', async () => {
    const origin = loopbackOrigin(await closedLoopbackPort());
    vi.stubEnv(DAPR_HTTP_ENDPOINT_ENV, origin);

    let failure: unknown;
    const warnings = await discoveryWarnings(() =>
      buildVerifier().catch((error: unknown) => {
        failure = error;
      })
    );

    expect(failure).toBeInstanceOf(IdentityNotConfiguredError);
    // The warning is what distinguishes "probed and failed" from "never
    // probed", which is how this case would otherwise pass vacuously.
    expect(namesOf(warnings)).toContain(DISCOVERY_FAILED_WARNING);
  });

  it('warns when the remote sidecar is unreachable', async () => {
    const origin = loopbackOrigin(await closedLoopbackPort());
    vi.stubEnv(DAPR_HTTP_ENDPOINT_ENV, origin);
    vi.stubEnv(DAPR_API_TOKEN_ENV, API_TOKEN);

    const warnings = await discoveryWarnings(() => buildVerifier());

    // A misconfigured endpoint must not be a debug line nobody sees: without
    // it an app verifies against whatever issuer the environment happened to
    // export, silently.
    expect(namesOf(warnings)).toContain(DISCOVERY_FAILED_WARNING);
    const logged = messagesOf(warnings);
    expect(logged).toContain(`${origin}${METADATA_PATH}`);
    expect(logged).toContain('trying the next source');
    expect(logged).not.toContain(API_TOKEN);
  });

  it('warns when the local sidecar is unreachable', async () => {
    // The local source warns at the same level, not only the remote one.
    const port = await closedLoopbackPort();
    vi.stubEnv(DAPR_HTTP_PORT_ENV, String(port));

    const warnings = await discoveryWarnings(() => buildVerifier());

    expect(namesOf(warnings)).toContain(DISCOVERY_FAILED_WARNING);
    expect(messagesOf(warnings)).toContain(
      `${loopbackOrigin(port)}${METADATA_PATH}`
    );
  });

  it('says nothing at all when no endpoint is configured', async () => {
    // An absent source is not a failure. Warning about one would make every
    // in-cluster app log about the remote endpoint it correctly does not have.
    vi.stubEnv(
      DP_SENTRY_ISSUER_ENV,
      loopbackOrigin(await closedLoopbackPort())
    );
    stubUnreachableFetch();

    const warnings = await discoveryWarnings(() => buildVerifier());

    expect(namesOf(warnings)).toEqual([]);
  });

  it('warns that a token sent over plain http is in the clear', async () => {
    const sidecar = await startMetadataServer(selfPublishing);
    vi.stubEnv(DAPR_HTTP_ENDPOINT_ENV, sidecar.origin);
    vi.stubEnv(DAPR_API_TOKEN_ENV, API_TOKEN);

    const warnings = await discoveryWarnings(() => buildVerifier());

    expect(namesOf(warnings)).toContain(PLAINTEXT_TOKEN_WARNING);
    const logged = messagesOf(warnings);
    expect(logged).toContain(sidecar.origin);
    // The warning must not be the leak it is warning about.
    expect(logged).not.toContain(API_TOKEN);
    // Warned, and still sent: a self-hosted sidecar on plain http is a valid
    // setup, so this is advice rather than a refusal.
    expect(metadataRequests(sidecar)[0]?.apiToken).toBe(API_TOKEN);
  });

  it('does not warn about a token sent over https', async () => {
    // A closed port over https: the probe fails, but the clear-text check is
    // made from the endpoint's scheme before anything is sent, so its silence
    // here is the assertion. The discovery warning proves the endpoint was
    // used at all, which is what stops this passing vacuously.
    const port = await closedLoopbackPort();
    vi.stubEnv(DAPR_HTTP_ENDPOINT_ENV, `https://${LOOPBACK_HOST}:${port}`);
    vi.stubEnv(DAPR_API_TOKEN_ENV, API_TOKEN);

    const warnings = await discoveryWarnings(() => buildVerifier());

    expect(namesOf(warnings)).toContain(DISCOVERY_FAILED_WARNING);
    expect(namesOf(warnings)).not.toContain(PLAINTEXT_TOKEN_WARNING);
  });

  it('discovers nothing from a malformed metadata body', async () => {
    const malformed: unknown[] = [
      ['not', 'an', 'object'],
      { identity: { issuer: 123 } },
      { identity: {} },
      metadataBody(undefined),
      null,
    ];

    for (const body of malformed) {
      const sidecar = await startMetadataServer(() => body);
      vi.stubEnv(DAPR_HTTP_ENDPOINT_ENV, sidecar.origin);

      // No coordinates rather than an error: a body this module cannot read is
      // a source with no answer, exactly like an unreachable one.
      await expect(
        buildVerifier(),
        `${JSON.stringify(body)} must not resolve`
      ).rejects.toBeInstanceOf(IdentityNotConfiguredError);
      // Fetched and read, not skipped: without this the case would pass just
      // as readily against a remote source that does not exist.
      expect(metadataRequests(sidecar)).toHaveLength(1);
      vi.unstubAllEnvs();
    }
  });
});

describe('discovery precedence', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers the local sidecar over the remote one', async () => {
    // Deliberate: a deployed in-cluster app must keep using the loopback call
    // rather than paying for a network round trip on every cold start.
    const local = await startMetadataServer(selfPublishing);
    const remote = await startMetadataServer(selfPublishing);
    vi.stubEnv(DAPR_HTTP_PORT_ENV, String(new URL(local.origin).port));
    vi.stubEnv(DAPR_HTTP_ENDPOINT_ENV, remote.origin);

    const coordinates = await resolveCoordinates();

    expect(coordinates.issuer).toBe(local.origin);
    expect(metadataRequests(remote)).toEqual([]);
  });

  it('uses the remote sidecar when there is no local one', async () => {
    const remote = await startMetadataServer(selfPublishing);
    vi.stubEnv(DAPR_HTTP_ENDPOINT_ENV, remote.origin);

    const coordinates = await resolveCoordinates();

    expect(coordinates.issuer).toBe(remote.origin);
    expect(metadataRequests(remote)).toHaveLength(1);
  });

  it('falls through to the environment when the remote probe fails', async () => {
    const issuer = loopbackOrigin(await closedLoopbackPort());
    vi.stubEnv(
      DAPR_HTTP_ENDPOINT_ENV,
      loopbackOrigin(await closedLoopbackPort())
    );
    vi.stubEnv(DP_SENTRY_ISSUER_ENV, issuer);

    let coordinates: Awaited<ReturnType<typeof resolveCoordinates>> | undefined;
    const warnings = await discoveryWarnings(async () => {
      coordinates = await resolveCoordinates();
    });

    expect(coordinates?.issuer).toBe(issuer);
    expect(coordinates?.jwksUri).toBe(`${issuer}/jwks.json`);
    // Tried the remote endpoint on the way past it, rather than ignoring it.
    expect(namesOf(warnings)).toContain(DISCOVERY_FAILED_WARNING);
  });

  it('names both sidecar variables when nothing supplies an issuer', async () => {
    // The guidance an operator reads at 3am. It has to name the remote
    // endpoint, or `diagrid dev run` looks unsupported.
    stubUnreachableFetch();

    await expect(buildVerifier()).rejects.toThrow(
      new RegExp(`${DAPR_HTTP_PORT_ENV}.*${DAPR_HTTP_ENDPOINT_ENV}`)
    );
  });
});

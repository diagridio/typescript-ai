// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * `createIdentityFetch`, driven through a recording base `fetch`.
 *
 * Three properties: the token is read at *send* time, the header is *cleared*
 * before it is set, and it travels only to the origin the caller addressed.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  USER_TOKEN_HEADER,
  attachIdentityHeaders,
  createIdentityFetch,
  runWithUserToken,
} from '@diagrid/agent-core';

/** A single dispatched request, reduced to what the assertions care about. */
interface Dispatch {
  readonly url: string;
  readonly origin: string;
  readonly method: string;
  readonly token: string | null;
  readonly hasTokenHeader: boolean;
  readonly body: string;
}

interface Recorder {
  readonly fetch: typeof globalThis.fetch;
  readonly seen: Dispatch[];
}

/**
 * A base `fetch` that answers from `responses` and records what it was handed.
 *
 * `responses` is consumed one entry per dispatch, so a redirect chain is
 * scripted by listing the hops; the last entry repeats once the list runs out.
 */
function recorder(
  responses: readonly (() => Response)[] = [() => new Response('ok')]
): Recorder {
  const seen: Dispatch[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push({
      url: request.url,
      origin: url.origin,
      method: request.method,
      token: request.headers.get(USER_TOKEN_HEADER),
      hasTokenHeader: request.headers.has(USER_TOKEN_HEADER),
      body: await request.text(),
    });
    const next = responses[Math.min(seen.length - 1, responses.length - 1)];
    return next ? next() : new Response('ok');
  };

  return { fetch, seen };
}

/** A 3xx with a `Location`, the way a real callee would send one. */
const redirectTo = (status: number, location: string) => () =>
  new Response(null, { status, headers: { location } });

const servers: Server[] = [];

/** Serve `handler` on an ephemeral port, bound to every interface. */
async function startServer(
  handler: (
    path: string,
    token: string | undefined
  ) => [number, string, string?]
): Promise<{ readonly host: string; readonly port: number }> {
  const server = createServer((req, res) => {
    const [status, body, location] = handler(
      req.url ?? '/',
      req.headers['x-diagrid-user-token'] as string | undefined
    );
    res.writeHead(status, {
      'content-type': 'text/plain',
      ...(location === undefined ? {} : { location }),
    });
    res.end(body);
  });
  servers.push(server);

  // No host argument: `localhost` and `127.0.0.1` are different origins to a
  // URL parser but must both reach this server for the cross-host cases.
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;

  return { host: '127.0.0.1', port };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

describe('createIdentityFetch: the factory (P1)', () => {
  it('is a plain fetch-compatible function, not a client class', () => {
    // What lets it be handed to the MCP SDK, a generated client, or anything
    // else that takes a custom `fetch`. The annotation is half the assertion:
    // it fails to compile if the returned shape drifts from `fetch`.
    const identityFetch: typeof globalThis.fetch = createIdentityFetch();

    expect(typeof identityFetch).toBe('function');
    // Callable without `new`, which a client class would not be.
    expect(() => Reflect.construct(identityFetch, [])).toThrow();
  });

  it('accepts a string, a URL and a Request, like fetch does', async () => {
    const base = recorder();
    const identityFetch = createIdentityFetch({ fetch: base.fetch });

    await runWithUserToken('tok', async () => {
      await identityFetch('https://mcp.invalid/a');
      await identityFetch(new URL('https://mcp.invalid/b'));
      await identityFetch(new Request('https://mcp.invalid/c'));
    });

    expect(base.seen.map((d) => new URL(d.url).pathname)).toEqual([
      '/a',
      '/b',
      '/c',
    ]);
    expect(base.seen.map((d) => d.token)).toEqual([
      'Bearer tok',
      'Bearer tok',
      'Bearer tok',
    ]);
  });

  it('attaches the caller token to an ordinary call', async () => {
    const base = recorder();
    const identityFetch = createIdentityFetch({ fetch: base.fetch });

    await runWithUserToken('secret-obo', () =>
      identityFetch('https://mcp.invalid/call')
    );

    expect(base.seen[0]?.token).toBe('Bearer secret-obo');
  });

  it('returns the callee response untouched', async () => {
    const identityFetch = createIdentityFetch({
      fetch: () =>
        Promise.resolve(
          new Response('{"ok":true}', {
            status: 201,
            headers: { 'content-type': 'application/json' },
          })
        ),
    });

    const response = await runWithUserToken('tok', () =>
      identityFetch('https://mcp.invalid/call')
    );

    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"ok":true}');
  });
});

describe('createIdentityFetch: send-time token read (P2)', () => {
  it('reads the token at call time, not at construction time', async () => {
    const base = recorder();
    // Constructed with no inbound context at all. A constructor-time read
    // would bake in "no token" and never recover.
    const identityFetch = createIdentityFetch({ fetch: base.fetch });

    await runWithUserToken('later', () =>
      identityFetch('https://mcp.invalid/call')
    );

    expect(base.seen[0]?.token).toBe('Bearer later');
  });

  it('carries each concurrent caller its own token through one shared client', async () => {
    // The property that makes a single long-lived, module-scope client safe,
    // and the cross-user identity leak a constructor-captured token would be.
    //
    // A barrier rather than two sleeps, so the overlap is certain rather than
    // likely: neither dispatch is answered until both have arrived, so both
    // requests provably existed at once.
    const tokens = new Map<string, string | null>();
    let arrived = 0;
    let bothArrived: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      bothArrived = resolve;
    });

    const identityFetch = createIdentityFetch({
      fetch: async (input) => {
        const request = new Request(input);
        tokens.set(
          new URL(request.url).pathname,
          request.headers.get(USER_TOKEN_HEADER)
        );
        arrived += 1;
        if (arrived === 2) {
          bothArrived();
        }
        await barrier;
        return new Response('ok');
      },
    });

    await Promise.all([
      runWithUserToken('alice', () =>
        identityFetch('https://mcp.invalid/alice')
      ),
      runWithUserToken('bob', () => identityFetch('https://mcp.invalid/bob')),
    ]);

    expect(tokens.get('/alice')).toBe('Bearer alice');
    expect(tokens.get('/bob')).toBe('Bearer bob');
  });
});

describe('createIdentityFetch: the header is cleared first (P3)', () => {
  it('omits the header entirely when there is no inbound caller', async () => {
    const base = recorder();
    const identityFetch = createIdentityFetch({ fetch: base.fetch });

    // A scheduled, pub/sub or cron trigger. An empty header value would look
    // like a malformed token to the receiving side.
    await identityFetch('https://mcp.invalid/call');

    expect(base.seen[0]?.hasTokenHeader).toBe(false);
    expect(base.seen[0]?.token).toBeNull();
  });

  it('strips a stale header the caller supplied when the context has none', async () => {
    const base = recorder();
    const identityFetch = createIdentityFetch({ fetch: base.fetch });

    await identityFetch('https://mcp.invalid/call', {
      headers: { [USER_TOKEN_HEADER]: 'Bearer stale' },
    });

    expect(base.seen[0]?.hasTokenHeader).toBe(false);
  });

  it('does not throw when there is no inbound context (P7)', async () => {
    const base = recorder();
    const identityFetch = createIdentityFetch({ fetch: base.fetch });

    const response = await identityFetch('https://mcp.invalid/call');

    expect(response.ok).toBe(true);
  });
});

describe('createIdentityFetch: origin pinning across redirects (P4)', () => {
  interface RedirectCase {
    /** The case name. */
    readonly id: string;
    /** The URL the app called. */
    readonly called: string;
    /** Where the callee's `Location` sends it. */
    readonly location: string;
    /** Whether the token may follow. */
    readonly forwarded: boolean;
  }

  const HTTPS_CALL = 'https://mcp.invalid/call';

  const cases: readonly RedirectCase[] = [
    {
      id: 'same-origin',
      called: HTTPS_CALL,
      location: 'https://mcp.invalid/call/',
      forwarded: true,
    },
    {
      id: 'https-upgrade',
      called: 'http://mcp.invalid/call',
      location: HTTPS_CALL,
      forwarded: true,
    },
    {
      id: 'different-host',
      called: HTTPS_CALL,
      location: 'https://evil.example/steal',
      forwarded: false,
    },
    {
      id: 'different-port',
      called: HTTPS_CALL,
      location: 'https://mcp.invalid:9999/steal',
      forwarded: false,
    },
    {
      id: 'upgrade-to-different-port',
      called: 'http://mcp.invalid:8080/call',
      location: 'https://mcp.invalid:9999/steal',
      forwarded: false,
    },
    {
      id: 'downgrade-to-http',
      called: HTTPS_CALL,
      location: 'http://mcp.invalid/call',
      forwarded: false,
    },
    {
      id: 'subdomain',
      called: HTTPS_CALL,
      location: 'https://sub.mcp.invalid/call',
      forwarded: false,
    },
  ];

  it.each(cases)(
    '$id: the token reaches the redirect target only when it is the origin called',
    async ({ called, location, forwarded }) => {
      const base = recorder([
        redirectTo(307, location),
        () => new Response('ok'),
      ]);
      const identityFetch = createIdentityFetch({ fetch: base.fetch });

      await runWithUserToken('secret-obo', () => identityFetch(called));

      expect(base.seen.map((d) => d.origin)).toEqual([
        new URL(called).origin,
        new URL(location).origin,
      ]);
      expect(base.seen.map((d) => d.token)).toEqual([
        'Bearer secret-obo',
        forwarded ? 'Bearer secret-obo' : null,
      ]);
      // Not merely emptied.
      expect(base.seen[1]?.hasTokenHeader).toBe(forwarded);
    }
  );

  it('drops the header on a cross-origin hop against a real server', async () => {
    // The hermetic cases above prove the rule; this proves the plumbing —
    // that a real `fetch` under the wrapper does not follow the hop itself,
    // below the point where the header decision is made.
    const target = await startServer((path, token) => [
      200,
      `${path} token=${token ?? 'NONE'}`,
    ]);
    const redirector = await startServer(() => [
      302,
      '',
      `http://localhost:${target.port}/target`,
    ]);

    const identityFetch = createIdentityFetch();
    const response = await runWithUserToken('secret-obo', () =>
      identityFetch(`http://${redirector.host}:${redirector.port}/start`)
    );

    expect(await response.text()).toBe('/target token=NONE');
  });

  it('keeps the header on a same-origin hop against a real server', async () => {
    const server = await startServer((path, token) =>
      path === '/start'
        ? [302, '', '/final']
        : [200, `${path} token=${token ?? 'NONE'}`]
    );

    const identityFetch = createIdentityFetch();
    const response = await runWithUserToken('secret-obo', () =>
      identityFetch(`http://${server.host}:${server.port}/start`)
    );

    expect(await response.text()).toBe('/final token=Bearer secret-obo');
  });

  /** Dispatch one POST through a `status` redirect to the same origin. */
  const postThrough = async (status: number): Promise<Dispatch[]> => {
    const base = recorder([
      redirectTo(status, 'https://mcp.invalid/next'),
      () => new Response('ok'),
    ]);

    await runWithUserToken('tok', () =>
      createIdentityFetch({ fetch: base.fetch })('https://mcp.invalid/call', {
        method: 'POST',
        body: '{"q":1}',
      })
    );

    return base.seen;
  };

  it('resends the body on a 308, the way the stack would have', async () => {
    expect((await postThrough(308)).map((d) => [d.method, d.body])).toEqual([
      ['POST', '{"q":1}'],
      ['POST', '{"q":1}'],
    ]);
  });

  it('turns a 303 into a bodyless GET, the way the stack would have', async () => {
    expect((await postThrough(303)).map((d) => [d.method, d.body])).toEqual([
      ['POST', '{"q":1}'],
      ['GET', ''],
    ]);
  });

  it('honours a caller-supplied redirect mode instead of following', async () => {
    const base = recorder([redirectTo(302, 'https://evil.example/steal')]);
    const identityFetch = createIdentityFetch({ fetch: base.fetch });

    const response = await runWithUserToken('tok', () =>
      identityFetch('https://mcp.invalid/call', { redirect: 'manual' })
    );

    expect(response.status).toBe(302);
    expect(base.seen).toHaveLength(1);
  });

  it('refuses a redirect chain longer than maxRedirects', async () => {
    const base = recorder([redirectTo(307, 'https://mcp.invalid/loop')]);
    const identityFetch = createIdentityFetch({
      fetch: base.fetch,
      maxRedirects: 2,
    });

    await expect(
      runWithUserToken('tok', () => identityFetch('https://mcp.invalid/call'))
    ).rejects.toThrow(TypeError);
    expect(base.seen).toHaveLength(3);
  });
});

describe('createIdentityFetch: caller-supplied fetch survives (P5)', () => {
  it('delegates to the fetch the caller passed', async () => {
    const calls: string[] = [];
    const identityFetch = createIdentityFetch({
      fetch: (input) => {
        calls.push(new Request(input).url);
        return Promise.resolve(new Response('ok'));
      },
    });

    await runWithUserToken('tok', () =>
      identityFetch('https://mcp.invalid/call')
    );

    expect(calls).toEqual(['https://mcp.invalid/call']);
  });

  it('keeps caller headers and lets identity win over the same header', async () => {
    const base = recorder();
    const identityFetch = createIdentityFetch({ fetch: base.fetch });
    const headers = {
      'content-type': 'application/json',
      [USER_TOKEN_HEADER]: 'Bearer caller-set',
    };

    await runWithUserToken('real', () =>
      identityFetch('https://mcp.invalid/call', { method: 'POST', headers })
    );

    expect(base.seen[0]?.token).toBe('Bearer real');
    // The caller's own object is not written through.
    expect(headers[USER_TOKEN_HEADER]).toBe('Bearer caller-set');
  });

  it('does not mutate a Headers instance the caller reuses', async () => {
    const base = recorder();
    const identityFetch = createIdentityFetch({ fetch: base.fetch });
    const headers = new Headers({ 'x-trace': 'abc' });

    await runWithUserToken('tok', () =>
      identityFetch('https://mcp.invalid/call', { headers })
    );

    expect(headers.has(USER_TOKEN_HEADER)).toBe(false);
    expect(base.seen[0]?.hasTokenHeader).toBe(true);
  });
});

describe('attachIdentityHeaders: the interceptor on its own (P6)', () => {
  it('sets the caller token on a request in place', () => {
    const request = new Request('https://mcp.invalid/call');

    runWithUserToken('secret-obo', () => attachIdentityHeaders(request));

    expect(request.headers.get(USER_TOKEN_HEADER)).toBe('Bearer secret-obo');
  });

  it('clears the header when the context holds no token', () => {
    const request = new Request('https://mcp.invalid/call', {
      headers: { [USER_TOKEN_HEADER]: 'Bearer stale' },
    });

    attachIdentityHeaders(request);

    expect(request.headers.has(USER_TOKEN_HEADER)).toBe(false);
  });

  it('composes into a fetch the app already owns', async () => {
    const base = recorder();
    const ownFetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      attachIdentityHeaders(request);
      return base.fetch(request);
    };

    await runWithUserToken('tok', () => ownFetch('https://mcp.invalid/call'));

    expect(base.seen[0]?.token).toBe('Bearer tok');
  });
});

// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Tests for the anonymous usage reporter in `packages/core/src/analytics.ts`.
 *
 * Port of `tests/core/test_analytics.py` in the sibling `diagridio/python-ai`
 * repo. `tests/setup.unit.ts` forces `DIAGRID_NO_ANALYTICS=1` for the whole
 * unit project; this file deletes it in its own `beforeEach` and stubs
 * `fetch`, so nothing here ever reaches the real Scarf endpoint.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as analytics from '../../packages/core/src/analytics';

const ENDPOINT = 'https://example.invalid/typescript-ai';

const ENV_TO_CLEAR = [
  ...analytics.OPT_OUT_ENV_VARS,
  ...analytics.CI_TRUTHY_ENV_VARS,
  ...analytics.CI_PRESENCE_ENV_VARS,
  ...analytics.DAPR_ENDPOINT_ENV_VARS,
  'DAPR_API_TOKEN',
] as const;

let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalEnv = Object.fromEntries(
    ENV_TO_CLEAR.map((key) => [key, process.env[key]])
  );
  for (const key of ENV_TO_CLEAR) {
    delete process.env[key];
  }
  // The whole unit suite runs with this on (tests/setup.unit.ts); these tests
  // exercise the reporter for real, against a stubbed fetch.
  delete process.env['DIAGRID_NO_ANALYTICS'];

  analytics.__resetReportedPackagesForTests();
  analytics.__setEndpointForTests('');
  analytics.internal.usageReportingDisabled = analytics.usageReportingDisabled;
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  analytics.__setEndpointForTests('');
  analytics.__resetReportedPackagesForTests();
  vi.unstubAllGlobals();
});

/** Flushes the microtask queue so a fire-and-forget `sendEvent` has settled. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('reportUsage', () => {
  it('does nothing while the endpoint is empty', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    analytics.__setEndpointForTests('');
    analytics.reportUsage('diagrid-test');
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is enabled when no opt-out variable is set', () => {
    expect(analytics.usageReportingDisabled()).toBe(false);
  });

  it.each(analytics.OPT_OUT_ENV_VARS)('%s disables reporting', (name) => {
    process.env[name] = '1';
    expect(analytics.usageReportingDisabled()).toBe(true);
  });

  it.each(['0', 'false', 'no', 'off', ''])(
    'falsy value %j does not disable reporting',
    (value) => {
      process.env['DO_NOT_TRACK'] = value;
      expect(analytics.usageReportingDisabled()).toBe(false);
    }
  );

  it.each(['1', 'TRUE', ' yes ', 'On'])(
    'truthy value %j is case- and space-insensitive',
    (value) => {
      process.env['DO_NOT_TRACK'] = value;
      expect(analytics.usageReportingDisabled()).toBe(true);
    }
  );

  it('sends no event when opted out', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    analytics.__setEndpointForTests(ENDPOINT);
    process.env['DO_NOT_TRACK'] = '1';

    analytics.reportUsage('diagrid-test');
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends one event per distinct package, never a second for the same one', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    analytics.__setEndpointForTests(ENDPOINT);

    analytics.reportUsage('diagrid-test-a', { kind: 'agent' });
    analytics.reportUsage('diagrid-test-a', { kind: 'agent' });
    analytics.reportUsage('diagrid-test-b');
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('package=diagrid-test-a'))).toBe(
      true
    );
    expect(urls.some((url) => url.includes('package=diagrid-test-b'))).toBe(
      true
    );
  });

  it('swallows a fetch rejection', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error('network unreachable'));
    vi.stubGlobal('fetch', fetchMock);
    analytics.__setEndpointForTests(ENDPOINT);

    expect(() => analytics.reportUsage('diagrid-test')).not.toThrow();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sets an abort timer, unref-ed, bounded to USAGE_TIMEOUT_MS', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    analytics.__setEndpointForTests(ENDPOINT);

    const unref = vi.fn();
    const realSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: () => void, ms?: number) => {
        const timer = realSetTimeout(fn, ms);
        timer.unref = unref;
        return timer;
      }) as typeof setTimeout);

    analytics.reportUsage('diagrid-test');
    await flush();

    expect(setTimeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      analytics.USAGE_TIMEOUT_MS
    );
    expect(unref).toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
  });

  it('never throws even when a helper throws', () => {
    analytics.__setEndpointForTests(ENDPOINT);
    analytics.internal.usageReportingDisabled = () => {
      throw new Error('boom');
    };

    expect(() => analytics.reportUsage('diagrid-test')).not.toThrow();
  });
});

describe('buildUrl', () => {
  beforeEach(() => {
    analytics.__setEndpointForTests(ENDPOINT);
  });

  it('contains the expected dimensions', () => {
    const url = analytics.buildUrl('diagrid-test', {
      kind: 'agent',
      framework: 'Mastra',
    });

    expect(url.startsWith(`${ENDPOINT}?`)).toBe(true);
    for (const fragment of [
      'package=diagrid-test',
      'version=',
      'os=',
      'arch=',
      'node_version=',
      'target=dapr',
      'ci=false',
      'kind=agent',
      'framework=Mastra',
    ]) {
      expect(url).toContain(fragment);
    }
  });

  it('lets caller dimensions override defaults, and drops empty ones', () => {
    const url = analytics.buildUrl('diagrid-test', {
      target: 'catalyst',
      framework: '',
      kind: null,
    });

    expect(url).toContain('target=catalyst');
    expect(url).not.toContain('framework=');
    expect(url).not.toContain('kind=');
  });

  it('trims and bounds dimension values', () => {
    const url = analytics.buildUrl('diagrid-test', {
      framework: '  ' + 'x'.repeat(200) + '  ',
    });

    expect(url).toContain(
      `framework=${'x'.repeat(analytics.DIMENSION_MAX_LEN)}`
    );
    expect(url).not.toContain('x'.repeat(analytics.DIMENSION_MAX_LEN + 1));
  });
});

describe('isRunningInCi', () => {
  it.each([
    [{}, false],
    [{ CI: 'true' }, true],
    [{ CI: '0' }, false],
    [{ GITHUB_ACTIONS: 'true' }, true],
    [{ TF_BUILD: 'True' }, true],
    [{ BUILDKITE: 'true' }, true],
    [{ JENKINS_URL: 'https://ci.example.invalid/' }, true],
  ])('%j -> %s', (env, expected) => {
    for (const [name, value] of Object.entries(env)) {
      process.env[name] = value;
    }

    expect(analytics.isRunningInCi()).toBe(expected);
    analytics.__setEndpointForTests(ENDPOINT);
    const url = analytics.buildUrl('diagrid-test');
    expect(url.includes('ci=true')).toBe(expected);
  });
});

describe('detectTarget', () => {
  it.each([
    [{}, 'dapr'],
    [{ DAPR_HTTP_ENDPOINT: 'http://localhost:3500' }, 'dapr'],
    [
      { DAPR_GRPC_ENDPOINT: 'https://grpc-prj1.api.cloud.diagrid.io:443' },
      'catalyst',
    ],
    [
      { DAPR_HTTP_ENDPOINT: 'https://http-prj1.api.cloud.diagrid.io' },
      'catalyst',
    ],
    [{ DAPR_GRPC_ENDPOINT: 'https://notdiagrid.io:443' }, 'dapr'],
    [{ DAPR_API_TOKEN: 'diagrid://abc' }, 'catalyst'],
    [{ DAPR_API_TOKEN: '   ' }, 'dapr'],
  ])('%j -> %s', (env, expected) => {
    for (const [name, value] of Object.entries(env)) {
      process.env[name] = value;
    }

    expect(analytics.detectTarget()).toBe(expected);
  });
});

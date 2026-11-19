// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The `integration` project builds real runners, and a runner calls
 * `reportUsage` when it is built. This file proves that the project sets the
 * opt-out, so no integration or e2e run sends an event to Scarf. It needs no
 * Dapr sidecar and no model.
 */

import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as analytics from '../../packages/core/src/analytics';

afterEach(() => {
  analytics.__setEndpointForTests('');
  analytics.__resetReportedPackagesForTests();
  vi.unstubAllGlobals();
});

describe('integration project analytics opt-out', () => {
  it('sets DIAGRID_NO_ANALYTICS in the test worker', () => {
    expect(process.env['DIAGRID_NO_ANALYTICS']).toBe('1');
    expect(analytics.usageReportingDisabled()).toBe(true);
  });

  it('sends nothing from reportUsage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null));
    vi.stubGlobal('fetch', fetchMock);
    analytics.__setEndpointForTests('https://example.invalid/events');

    analytics.reportUsage('diagrid-integration-optout-test');
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes the opt-out to child processes', () => {
    const result = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.DIAGRID_NO_ANALYTICS ?? "")'],
      { encoding: 'utf8' }
    );
    expect(result.stdout).toBe('1');
  });
});

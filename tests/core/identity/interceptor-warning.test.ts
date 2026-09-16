// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The limitation `attachIdentityHeaders` cannot engineer away, said out loud.
 *
 * Used on its own the interceptor sees one `Request` and nothing else: whatever
 * performs the call follows redirects below that point, so the per-hop origin
 * guard `createIdentityFetch` enforces cannot be reconstructed from there. A
 * doc comment is not read by the app that is already leaking, so there is a
 * warning too, and these are its cases.
 *
 * Its own file because the warning fires once per process, and Vitest gives
 * each test file a module registry of its own — the flag is therefore fresh
 * here and these assertions cannot be made vacuous by another file's calls.
 */

import { describe, expect, it } from 'vitest';

import {
  USER_TOKEN_HEADER,
  attachIdentityHeaders,
  runWithUserToken,
} from '@diagrid/agent-core';

/** The `process.emitWarning` type the interceptor's warning carries. */
const REDIRECT_UNGUARDED_WARNING = 'DiagridIdentityRedirectUnguarded';

/** Warnings of that type emitted while `run` ran. */
async function warningsDuring(run: () => void): Promise<Error[]> {
  const seen: Error[] = [];
  const listener = (warning: Error): void => {
    if (warning.name === REDIRECT_UNGUARDED_WARNING) {
      seen.push(warning);
    }
  };
  process.on('warning', listener);
  try {
    run();
    // `process.emitWarning` dispatches on the next tick.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('warning', listener);
  }
  return seen;
}

describe('attachIdentityHeaders: the unguarded-redirect warning', () => {
  it('says nothing for a request that will not be followed', async () => {
    // `manual` and `error` are the two modes under which the interceptor is
    // sound: there is no hop to guard.
    const warnings = await warningsDuring(() => {
      for (const redirect of ['manual', 'error'] as const) {
        attachIdentityHeaders(
          new Request('https://mcp.invalid/call', { redirect })
        );
      }
    });

    expect(warnings).toEqual([]);
  });

  it('warns once, however many calls will follow redirects', async () => {
    // Once per process, not once per request: this is an interceptor on the hot
    // path, where a warning per call is noise an operator filters out.
    const warnings = await warningsDuring(() => {
      attachIdentityHeaders(new Request('https://mcp.invalid/one'));
      attachIdentityHeaders(new Request('https://mcp.invalid/two'));
    });

    expect(warnings.map((warning) => warning.name)).toEqual([
      REDIRECT_UNGUARDED_WARNING,
    ]);
    // Both remedies named in the line an operator will actually see.
    expect(warnings[0]?.message).toContain('createIdentityFetch');
    expect(warnings[0]?.message).toContain('manual');
  });

  it('still sets and clears the header it was handed', () => {
    // The warning is advice. It must not change what the interceptor does.
    const request = new Request('https://mcp.invalid/call', {
      headers: { [USER_TOKEN_HEADER]: 'Bearer stale' },
    });

    runWithUserToken('fresh', () => {
      attachIdentityHeaders(request);
    });

    expect(request.headers.get(USER_TOKEN_HEADER)).toBe('Bearer fresh');
  });
});

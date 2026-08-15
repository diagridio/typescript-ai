// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Drift guard for the locally declared workflow status enum.
 *
 * `@diagrid/agent-core` declares `WorkflowRuntimeStatus` itself rather than
 * re-exporting the SDK's, so that a bare `require('@diagrid/agent-core')` does
 * not pull ~136 `@dapr/dapr` modules and ~65 `@grpc/grpc-js` modules into the
 * runtime graph. That trade is only safe while the two agree.
 *
 * This test imports the SDK directly — a test may pay that cost — and fails if a
 * dependency bump renumbers or adds a member. Without it, a silent renumber
 * would make `invoke()` read a completed workflow as failed.
 */

import { WorkflowRuntimeStatus as DaprStatus } from '@dapr/dapr';
import { describe, expect, it } from 'vitest';

import { WorkflowRuntimeStatus, workflowStatusName } from '@diagrid/agent-core';

describe('WorkflowRuntimeStatus', () => {
  it('matches every member of the SDK enum by name and value', () => {
    // A numeric TS enum is a bidirectional map; keep only the name -> value half.
    const sdk = Object.fromEntries(
      Object.entries(DaprStatus).filter(
        ([, value]) => typeof value === 'number'
      )
    );

    expect({ ...WorkflowRuntimeStatus }).toEqual(sdk);
  });

  it('names a status for error messages', () => {
    expect(workflowStatusName(WorkflowRuntimeStatus.FAILED)).toBe('FAILED');
  });

  it('falls back to the raw number for a status it does not know', () => {
    // Better than printing `undefined` if the SDK ever adds a member.
    expect(workflowStatusName(99)).toBe('99');
  });
});

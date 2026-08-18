// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Guard: the names that leave this process are a contract, so they are pinned.
 *
 * Four strings here are not internal identifiers. They are agreed with the Dapr
 * sidecar and, in the checkpointer's case, with the other language SDKs:
 *
 * - the workflow name a sidecar routes an instance by;
 * - the activity names a worker registers and an orchestrator calls;
 * - the state-store keys `python-ai` reads and writes for the same threads.
 *
 * Changing any of them is a breaking change for something outside this repo, and
 * the failure mode is quiet: an in-flight workflow whose activity is suddenly
 * registered under a different name simply never gets serviced.
 *
 * They were exercised only indirectly — through a live `dapr run` — until the
 * durable loop moved from the Mastra adapter into core. That refactor could have
 * altered any of them by a character with every unit test still green, so the
 * literals are asserted here rather than derived, on purpose: a test that
 * recomputes the value it checks cannot detect a change to the formula.
 */

import { describe, expect, it } from 'vitest';

import {
  activityNamesFor,
  buildWorkflowName,
  checkpointKey,
  threadIndexKey,
  SupportedFrameworks,
} from '@diagrid/agent-core';
import {
  DaprMastraCheckpointer,
  MASTRA_KEY_PREFIX,
} from '@diagrid/agent-mastra';

describe('names agreed with the Dapr sidecar', () => {
  it('derives the canonical workflow name', () => {
    expect(buildWorkflowName(SupportedFrameworks.MASTRA, 'support-agent')).toBe(
      'dapr.mastra.SupportAgent.workflow'
    );
  });

  it('derives the per-agent activity names', () => {
    // Framework and agent both appear, and the framework token is lowercased the
    // same way the workflow name lowercases it — so the two names an operator
    // sees for one agent agree with each other.
    expect(
      activityNamesFor(SupportedFrameworks.MASTRA, 'support-agent')
    ).toEqual({
      model: 'diagrid.mastra.invokeModel.support-agent',
      tool: 'diagrid.mastra.invokeTool.support-agent',
    });
  });
});

describe('state-store keys shared with the other language SDKs', () => {
  it('lays out a checkpoint key', () => {
    expect(checkpointKey(MASTRA_KEY_PREFIX, 't1', 'cp-1')).toBe(
      'mastra-t1-checkpoint-cp-1'
    );
  });

  it('lays out a thread index key', () => {
    expect(threadIndexKey(MASTRA_KEY_PREFIX, 't1')).toBe('mastra-t1-index');
  });

  it('routes the adapter statics through the same layout', () => {
    // `DaprMastraCheckpointer` became a thin subclass of core's checkpointer.
    // Its static helpers must still produce the identical keys, or an upgrade
    // orphans every checkpoint already written.
    expect(DaprMastraCheckpointer.checkpointKey('t1', 'cp-1')).toBe(
      'mastra-t1-checkpoint-cp-1'
    );
    expect(DaprMastraCheckpointer.threadIndexKey('t1')).toBe('mastra-t1-index');
  });
});

// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Constructing a runner reports one anonymous usage event.
 *
 * Port of `TestBaseWorkflowRunnerUsageReporting` in the sibling
 * `diagridio/python-ai` repo's `tests/agent/core/test_workflow_runner.py`.
 * `framework_version` is not asserted here because it is never sent at all —
 * see the constructor's own comment in `../../../packages/core/src/workflow/runner.ts`
 * for why resolving a peer framework's installed version would violate
 * `tests/guards/cross-framework-imports.test.ts`'s adapter isolation guard.
 *
 * The analytics module is mocked outright rather than exercised for real:
 * this file is about the hook firing with the right arguments, not about the
 * reporter's own behavior, which `tests/core/analytics.test.ts` covers.
 * Constructing a `BaseWorkflowRunner` needs no `@dapr/dapr` mock — the SDK is
 * only imported (as types, erased at runtime) and dynamically `import()`-ed
 * from `start()`, which this file never calls.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMapper } from '../../../packages/core/src/mapping/base.js';

const reportUsage = vi.fn();

vi.mock('../../../packages/core/src/analytics.js', () => ({
  reportUsage: (pkg: string, dimensions: unknown) =>
    reportUsage(pkg, dimensions),
}));

const { BaseWorkflowRunner } =
  await import('../../../packages/core/src/workflow/runner.js');

/** Minimal concrete subclass — lifecycle is not exercised here. */
class TestRunner extends BaseWorkflowRunner {
  constructor() {
    super('Mastra', { name: 'test-runner' });
  }

  protected registerWorkflowComponents(): void {
    // Never reached: this suite never calls start().
  }

  get mapper(): AgentMapper {
    throw new Error('mapper is not exercised by this test');
  }
}

beforeEach(() => {
  reportUsage.mockClear();
});

describe('BaseWorkflowRunner usage reporting', () => {
  it('reports one anonymous usage event for @diagrid/agent-core', () => {
    new TestRunner();

    expect(reportUsage).toHaveBeenCalledTimes(1);
    expect(reportUsage).toHaveBeenCalledWith('@diagrid/agent-core', {
      kind: 'agent',
      framework: 'Mastra',
    });
  });

  it('does not send a framework_version dimension', () => {
    new TestRunner();

    const [, dimensions] = reportUsage.mock.calls[0] as [string, object];
    expect(dimensions).not.toHaveProperty('framework_version');
  });
});

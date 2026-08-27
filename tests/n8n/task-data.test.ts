// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * `completedNodeOutputToTaskData` — shared by `orchestrator.ts`'s `toRunData`
 * (every node accumulated so far, on every `recreateNodeExecutionStack` call)
 * and `execution-progress.ts`'s incremental sync (one node, right after it
 * finishes for real). Both callers need the SAME mapping, which is exactly
 * what this test pins.
 *
 * Imported directly from the source file, not the `@diagrid/n8n` barrel — see
 * `schemas.test.ts`'s own doc comment for why. `task-data.ts` only imports
 * `n8n-workflow` for its `ITaskData` TYPE (`import type { ITaskData } from
 * 'n8n-workflow'`), erased at compile time, so this file needs no sibling n8n
 * checkout to run, unlike `orchestrator.test.ts` in this same directory.
 */

import { describe, expect, it } from 'vitest';

import { completedNodeOutputToTaskData } from '../../packages/n8n/src/task-data';
import type { CompletedNodeOutput } from '../../packages/n8n/src/types';

describe('completedNodeOutputToTaskData', () => {
  it('maps a success result to a success ITaskData with the real item data', () => {
    const result: CompletedNodeOutput = {
      status: 'success',
      nodeName: 'Set A',
      runIndex: 0,
      startedAt: 1000,
      finishedAt: 1500,
      outputItems: [[{ json: { step1: 'done' } }]],
    };

    expect(completedNodeOutputToTaskData(result)).toEqual({
      startTime: 1000,
      executionTime: 500,
      executionIndex: 0,
      source: [],
      executionStatus: 'success',
      data: { main: [[{ json: { step1: 'done' } }]] },
    });
  });

  it('maps an error result to an error ITaskData, with no data field', () => {
    const result: CompletedNodeOutput = {
      status: 'error',
      nodeName: 'Flaky',
      runIndex: 0,
      startedAt: 2000,
      finishedAt: 2100,
      message: 'deliberate failure',
    };

    const taskData = completedNodeOutputToTaskData(result);

    expect(taskData).toMatchObject({
      startTime: 2000,
      executionTime: 100,
      executionIndex: 0,
      source: [],
      executionStatus: 'error',
      error: { message: 'deliberate failure', name: 'NodeOperationError' },
    });
    expect(taskData).not.toHaveProperty('data');
  });

  it('computes executionTime as the finishedAt/startedAt delta, not a copy of either', () => {
    const result: CompletedNodeOutput = {
      status: 'success',
      nodeName: 'Set A',
      runIndex: 0,
      startedAt: 1_000_000,
      finishedAt: 1_020_000,
      outputItems: [[]],
    };

    expect(completedNodeOutputToTaskData(result).executionTime).toBe(20_000);
  });

  it('always reports executionIndex 0 — no loops, a node runs at most once per orchestration', () => {
    const success: CompletedNodeOutput = {
      status: 'success',
      nodeName: 'A',
      runIndex: 0,
      startedAt: 0,
      finishedAt: 0,
      outputItems: [[]],
    };
    const error: CompletedNodeOutput = {
      status: 'error',
      nodeName: 'B',
      runIndex: 0,
      startedAt: 0,
      finishedAt: 0,
      message: 'x',
    };

    expect(completedNodeOutputToTaskData(success).executionIndex).toBe(0);
    expect(completedNodeOutputToTaskData(error).executionIndex).toBe(0);
  });
});

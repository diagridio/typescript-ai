// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import type { ITaskData } from 'n8n-workflow';

import type { CompletedNodeOutput } from './types';

/**
 * Maps one finished node's result to n8n's own per-node `ITaskData` shape.
 * Shared by two callers with two different timings for the SAME mapping:
 *  - orchestrator.ts's `toRunData`: builds the full `IRunData` for every node
 *    accumulated so far, each time `recreateNodeExecutionStack` needs it.
 *  - execution-progress.ts's incremental sync: maps exactly one node's
 *    result, right after the generic activity produces it for real, to
 *    append into n8n's own execution record before the rest of the workflow
 *    finishes.
 */
export function completedNodeOutputToTaskData(
  result: CompletedNodeOutput
): ITaskData {
  return {
    startTime: result.startedAt,
    executionTime: result.finishedAt - result.startedAt,
    executionIndex: 0, // no loops (yet — see README's Scope), so a node runs at most once per orchestration
    source: [],
    executionStatus: result.status,
    ...(result.status === 'success'
      ? { data: { main: result.outputItems } }
      : {
          error: {
            message: result.message,
            name: 'NodeOperationError',
          } as never,
        }),
  };
}

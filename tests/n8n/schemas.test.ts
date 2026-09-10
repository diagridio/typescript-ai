// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Zod-at-boundaries coverage for everything that crosses the workflow
 * boundary or gets read back from the ledger — see schemas.ts's own doc
 * comment for why these exist at all (a real, previously-missing piece of
 * rigor closed in this port).
 *
 * Imported directly from the source file (not via the `@diagrid/n8n` package
 * alias/barrel — `packages/n8n/src/index.ts` re-exports `register.ts`, which
 * has a real, VALUE-level `import { WorkflowExecute } from 'n8n-core';`, one
 * of this package's five optional peers. `schemas.ts` itself imports nothing
 * but `zod`, so importing it directly keeps this file runnable in a clean
 * checkout with no sibling n8n repo linked at all — unlike
 * `orchestrator.test.ts` in this same directory, which genuinely needs one.
 * See `packages/n8n/README.md`'s own Scope section for the full account of
 * why that split exists.
 */

import { describe, expect, it } from 'vitest';

import {
  logRoundStartInputSchema,
  nodeExecutionDataSchema,
  nodeShapeSchema,
  orchestrationInputSchema,
  orchestratorResultSchema,
  resolveSubWorkflowInputSchema,
  resolveSubWorkflowOutputSchema,
  runNodeInputSchema,
  runNodeOutputSchema,
  syncExecutionStatusInputSchema,
} from '../../packages/n8n/src/schemas';

const NODE = {
  name: 'Set A',
  type: 'n8n-nodes-base.set',
  typeVersion: 3.4,
  parameters: { foo: 'bar' },
};

describe('nodeShapeSchema', () => {
  it('accepts the minimal real INode shape', () => {
    expect(nodeShapeSchema.parse(NODE)).toMatchObject(NODE);
  });

  it('passes through fields it does not itself name (id, position, ...)', () => {
    const withExtras = {
      ...NODE,
      id: 'abc-123',
      position: [0, 0],
      disabled: true,
    };
    expect(nodeShapeSchema.parse(withExtras)).toEqual(withExtras);
  });

  it('rejects a node missing a required field', () => {
    const { typeVersion: _typeVersion, ...missing } = NODE;
    expect(() => nodeShapeSchema.parse(missing)).toThrow();
  });
});

describe('nodeExecutionDataSchema', () => {
  it('accepts a plain item and passes through binary/pairedItem', () => {
    const item = { json: { a: 1 }, pairedItem: { item: 0 } };
    expect(nodeExecutionDataSchema.parse(item)).toEqual(item);
  });

  it('rejects an item with no json field', () => {
    expect(() => nodeExecutionDataSchema.parse({ notJson: true })).toThrow();
  });
});

describe('runNodeInputSchema', () => {
  const VALID = {
    instanceId: '1',
    nodeName: 'Set A',
    runIndex: 0,
    attempt: 1,
    node: NODE,
    inputItems: [[{ json: {} }]],
  };

  it('accepts a well-formed activity input', () => {
    expect(runNodeInputSchema.parse(VALID)).toMatchObject(VALID);
  });

  it('treats isSubWorkflow as optional', () => {
    expect(runNodeInputSchema.parse(VALID)).not.toHaveProperty('isSubWorkflow');
    expect(
      runNodeInputSchema.parse({ ...VALID, isSubWorkflow: true }).isSubWorkflow
    ).toBe(true);
  });

  it('rejects a corrupt entry (e.g. a truncated write)', () => {
    expect(() => runNodeInputSchema.parse({ instanceId: '1' })).toThrow();
  });
});

describe('runNodeOutputSchema', () => {
  it('parses a success result', () => {
    const success = {
      status: 'success',
      nodeName: 'Set A',
      runIndex: 0,
      startedAt: 1,
      finishedAt: 2,
      outputItems: [[{ json: {} }]],
    };
    expect(runNodeOutputSchema.parse(success)).toEqual(success);
  });

  it('parses an error result, with an optional stack', () => {
    const error = {
      status: 'error',
      nodeName: 'Set A',
      runIndex: 0,
      startedAt: 1,
      finishedAt: 2,
      message: 'boom',
    };
    expect(runNodeOutputSchema.parse(error)).toEqual(error);

    const withStack = runNodeOutputSchema.parse({ ...error, stack: 'at ...' });
    if (withStack.status !== 'error') {
      throw new Error('expected the error branch');
    }
    expect(withStack.stack).toBe('at ...');
  });

  it('parses a waiting result, requiring waitTill', () => {
    const waiting = {
      status: 'waiting',
      nodeName: 'Wait',
      runIndex: 0,
      startedAt: 1,
      finishedAt: 2,
      outputItems: [[{ json: {} }]],
      waitTill: 1234567890,
    };
    expect(runNodeOutputSchema.parse(waiting)).toEqual(waiting);
  });

  it('rejects an unknown status — a ledger entry from a future, incompatible version', () => {
    expect(() =>
      runNodeOutputSchema.parse({ status: 'retrying', nodeName: 'x' })
    ).toThrow();
  });

  it('rejects a waiting result with no waitTill', () => {
    expect(() =>
      runNodeOutputSchema.parse({
        status: 'waiting',
        nodeName: 'Wait',
        runIndex: 0,
        startedAt: 1,
        finishedAt: 2,
        outputItems: [],
      })
    ).toThrow();
  });
});

describe('orchestratorResultSchema', () => {
  it('parses a success result', () => {
    const result = {
      status: 'success',
      nodeCount: 3,
      nodes: ['A', 'B', 'C'],
      outputItems: [[{ json: {} }]],
    };
    expect(orchestratorResultSchema.parse(result)).toEqual(result);
  });

  it('parses an error result', () => {
    const result = { status: 'error', failedNode: 'B', message: 'boom' };
    expect(orchestratorResultSchema.parse(result)).toEqual(result);
  });

  it('rejects a payload missing the discriminant', () => {
    expect(() => orchestratorResultSchema.parse({ nodeCount: 1 })).toThrow();
  });
});

describe('orchestrationInputSchema', () => {
  it('parses the top-level input replayed from EXECUTIONSTARTED history', () => {
    const input = {
      nodes: [NODE],
      connections: {},
      seed: [{ nodeName: 'Manual Trigger', outputItems: [[{ json: {} }]] }],
    };
    expect(orchestrationInputSchema.parse(input)).toMatchObject(input);
  });

  it('accepts isSubWorkflow as optional', () => {
    const input = { nodes: [], connections: {}, seed: [] };
    expect(orchestrationInputSchema.parse(input)).not.toHaveProperty(
      'isSubWorkflow'
    );
    expect(
      orchestrationInputSchema.parse({ ...input, isSubWorkflow: true })
        .isSubWorkflow
    ).toBe(true);
  });

  it('rejects a node array containing a malformed node', () => {
    expect(() =>
      orchestrationInputSchema.parse({
        nodes: [{ name: 'x' }],
        connections: {},
        seed: [],
      })
    ).toThrow();
  });
});

describe('syncExecutionStatusInputSchema', () => {
  it('accepts success with no error message', () => {
    expect(
      syncExecutionStatusInputSchema.parse({
        executionId: '1',
        status: 'success',
      })
    ).toEqual({ executionId: '1', status: 'success' });
  });

  it('accepts error with a message', () => {
    const input = { executionId: '1', status: 'error', errorMessage: 'boom' };
    expect(syncExecutionStatusInputSchema.parse(input)).toEqual(input);
  });

  it('rejects a status outside the closed union', () => {
    expect(() =>
      syncExecutionStatusInputSchema.parse({ executionId: '1', status: 'ok' })
    ).toThrow();
  });
});

describe('resolveSubWorkflowInputSchema / OutputSchema', () => {
  it('parses the input', () => {
    expect(resolveSubWorkflowInputSchema.parse({ workflowId: 'wf-1' })).toEqual(
      { workflowId: 'wf-1' }
    );
  });

  it('parses an ok:true output with nodes/connections', () => {
    const output = { ok: true, nodes: [NODE], connections: {} };
    expect(resolveSubWorkflowOutputSchema.parse(output)).toMatchObject(output);
  });

  it('parses an ok:false output with a message', () => {
    const output = { ok: false, message: 'not found' };
    expect(resolveSubWorkflowOutputSchema.parse(output)).toEqual(output);
  });

  it('rejects ok:true with no nodes field', () => {
    expect(() =>
      resolveSubWorkflowOutputSchema.parse({ ok: true, connections: {} })
    ).toThrow();
  });
});

describe('logRoundStartInputSchema', () => {
  it('parses a round-start payload', () => {
    const input = { instanceId: '1', round: 0, nodeNames: ['Set A', 'Set B'] };
    expect(logRoundStartInputSchema.parse(input)).toEqual(input);
  });
});

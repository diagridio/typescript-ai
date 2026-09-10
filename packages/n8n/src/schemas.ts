// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Zod schemas for everything that crosses the workflow boundary, or is read
 * back out of the state store — this repo's own convention (`AGENTS.md`:
 * "Zod at boundaries... on replay those values arrive from storage, which is
 * outside the process"), and a real, previously-missing piece of rigor in
 * this package: the original draft trusted `RunNodeOutput`/ledger reads with
 * a bare type cast.
 *
 * Deliberately proportionate, not exhaustive: `INode`/`IConnections`/
 * `INodeExecutionData` are n8n's own large, evolving types. Re-deriving them
 * fully in Zod would duplicate n8n's own type system and drift from it on
 * every n8n upgrade. Instead, `nodeShapeSchema`/`nodeExecutionDataSchema`
 * below validate the handful of fields this package actually reads
 * (`name`, `type`, `typeVersion`, `parameters`; `json`), with `.passthrough()`
 * for the rest — enough to catch real corruption (a truncated write, a
 * differently-shaped value from an old ledger entry) without pretending to be
 * a full n8n schema. Everything this package fully owns (the discriminated
 * `RunNodeOutput`/`OrchestratorResult` unions, activity I/O shapes) gets a
 * complete, exact schema.
 */

import { z } from 'zod';

/**
 * The minimal real shape of an n8n `INode` this package reads:
 * `name`/`type`/`typeVersion` to resolve and dispatch it, `parameters` to
 * pass to `execute()`. `.passthrough()` keeps every other real n8n field
 * (`id`, `position`, `credentials`, `disabled`, ...) intact rather than
 * stripping it — this package forwards the whole node object to
 * `executeNodeStandalone`, which needs the real thing, not a subset.
 */
export const nodeShapeSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    typeVersion: z.number(),
    parameters: z.record(z.string(), z.unknown()),
  })
  .passthrough();

/** `INodeExecutionData`: validate `json`, pass through binary/pairedItem/etc. */
export const nodeExecutionDataSchema = z
  .object({ json: z.record(z.string(), z.unknown()) })
  .passthrough();

export const outputItemsSchema = z.array(z.array(nodeExecutionDataSchema));

/** What the orchestrator sends the generic activity — see types.ts. */
export const runNodeInputSchema = z.object({
  instanceId: z.string(),
  nodeName: z.string(),
  runIndex: z.number(),
  attempt: z.number(),
  node: nodeShapeSchema,
  inputItems: outputItemsSchema,
  isSubWorkflow: z.boolean().optional(),
});

/**
 * What the generic activity returns — the value replayed from Dapr's own
 * history on every subsequent orchestrator replay, and the value read back
 * out of the idempotency ledger on a redelivered attempt. Both are exactly
 * the "read back from storage" case this repo's Zod-at-boundaries convention
 * targets directly.
 */
export const runNodeOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    nodeName: z.string(),
    runIndex: z.number(),
    startedAt: z.number(),
    finishedAt: z.number(),
    outputItems: outputItemsSchema,
  }),
  z.object({
    status: z.literal('error'),
    nodeName: z.string(),
    runIndex: z.number(),
    startedAt: z.number(),
    finishedAt: z.number(),
    message: z.string(),
    stack: z.string().optional(),
  }),
  z.object({
    status: z.literal('waiting'),
    nodeName: z.string(),
    runIndex: z.number(),
    startedAt: z.number(),
    finishedAt: z.number(),
    outputItems: outputItemsSchema,
    waitTill: z.number(),
  }),
]);

/** What `runN8nNodeOrchestrator`/`runN8nNodeOrchestratorV2` return. */
export const orchestratorResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    nodeCount: z.number(),
    nodes: z.array(z.string()),
    outputItems: outputItemsSchema,
  }),
  z.object({
    status: z.literal('error'),
    failedNode: z.string(),
    message: z.string(),
  }),
]);

/** `OrchestrationInput.seed` — pre-resolved trigger-node output. */
const seedEntrySchema = z.object({
  nodeName: z.string(),
  outputItems: outputItemsSchema,
});

/**
 * The full orchestration input — the very first thing replayed from an
 * instance's own `ExecutionStarted` history event on every replay, so this is
 * arguably the single most load-bearing schema in this file.
 */
export const orchestrationInputSchema = z.object({
  nodes: z.array(nodeShapeSchema),
  connections: z.record(z.string(), z.unknown()),
  isSubWorkflow: z.boolean().optional(),
  seed: z.array(seedEntrySchema),
});

/** execution-status-sync.ts's activity input. */
export const syncExecutionStatusInputSchema = z.object({
  executionId: z.string(),
  status: z.enum(['success', 'error']),
  errorMessage: z.string().optional(),
});

/** sub-workflow.ts's resolve activity input/output. */
export const resolveSubWorkflowInputSchema = z.object({
  workflowId: z.string(),
});

export const resolveSubWorkflowOutputSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    nodes: z.array(nodeShapeSchema),
    connections: z.record(z.string(), z.unknown()),
  }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);

/** round-log.ts's v2-only activity input. */
export const logRoundStartInputSchema = z.object({
  instanceId: z.string(),
  round: z.number(),
  nodeNames: z.array(z.string()),
});

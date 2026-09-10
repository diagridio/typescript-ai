// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import type { WorkflowActivityContext } from '@diagrid/agent-core';
import { Container } from '@n8n/di';
import type { WorkflowRepository as WorkflowRepositoryType } from '@n8n/db';
import type {
  IConnections,
  INode,
  INodeParameterResourceLocator,
} from 'n8n-workflow';

import { resolveSubWorkflowInputSchema } from './schemas';

/**
 * Extracts the target workflow id from an Execute Workflow node's parameters
 * — "select workflow by id" (source: 'database') only.
 *
 * TODO(n8n-integration): the other three source modes (parameter/JSON, local
 * file, URL — see ExecuteWorkflow.node.ts's own `source` property) are out of
 * scope for this pass.
 *
 * Confirmed against the real node
 * (packages/nodes-base/nodes/ExecuteWorkflow/ExecuteWorkflow/
 * GenericFunctions.ts's own `getWorkflowInfo`): version 1 stores a plain
 * string directly on the `workflowId` parameter; version 1.1+ uses the
 * `workflowSelector` parameter type, an `INodeParameterResourceLocator`
 * (`{ mode, value, ... }`) — `value` is the actual id either way.
 *
 * TODO(n8n-integration): does NOT evaluate expressions (e.g. an `={{ ... }}`
 * dynamic workflow id) — this package has no per-node expression-evaluation
 * context at the orchestrator level, and deliberately can't: the orchestrator
 * must stay side-effect/IO-free and replay-deterministic (see
 * orchestrator.ts), and expression evaluation needs the isolate machinery
 * execute-node.ts's `withIsolate` wraps, which only exists inside an
 * activity. Only a literal id is supported.
 */
export function getSubWorkflowId(node: INode): string {
  const raw = (node.parameters as { workflowId?: unknown }).workflowId;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (raw && typeof raw === 'object' && 'value' in raw) {
    const { value } = raw as INodeParameterResourceLocator;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  throw new Error(
    `@diagrid/n8n: could not resolve a literal sub-workflow id from node "${node.name}" — ` +
      'only a plain string or a resourceLocator { value } is supported (no expressions, no non-database source).'
  );
}

export interface ResolveSubWorkflowInput {
  workflowId: string;
}

/**
 * Discriminated, not thrown: matches this package's established pattern
 * (runN8nNodeActivity never throws either — see activity.ts) of catching
 * activity-side failures internally and returning a plain result, rather
 * than relying on Dapr's own TASKFAILED/generator-throw propagation.
 */
export type ResolveSubWorkflowOutput =
  | { ok: true; nodes: INode[]; connections: IConnections }
  | { ok: false; message: string };

/**
 * Dapr activity: fetches a workflow's nodes/connections by id from n8n's own
 * database, via the same DI-registered-repository pattern already proven for
 * `ExecutionRepository` (see execution-status-sync.ts) — `WorkflowRepository`
 * is a plain `@Service()` in `@n8n/db`
 * (packages/@n8n/db/src/repositories/workflow.repository.ts). Lazy-imported
 * for the same reason as `ExecutionRepository`.
 *
 * No idempotency ledger here, unlike runN8nNodeActivity — deliberately: this
 * is a pure database read with no side effect of its own to duplicate, so
 * even if Dapr's at-least-once activity redelivery invoked it more than once
 * before recording a result, running the read again is harmless.
 *
 * TODO(n8n-integration): uses the workflow's current `nodes`/`connections`
 * columns directly — real n8n's own `executeWorkflow()`
 * (packages/cli/src/workflow-execute-additional-data.ts) distinguishes a
 * "draft" vs "published" version for manual/chat executions vs production
 * ones (`useDraftVersion`); this package only ever runs in `mode: 'manual'`
 * (see run-durably.ts), so using the current row is the same choice real n8n
 * makes for that mode — but the published-version distinction itself isn't
 * replicated.
 *
 * Input/output are both Zod-validated at this activity boundary — the input
 * comes from the orchestrator (replayed from Dapr's own history on every
 * subsequent replay); the output, once returned, is likewise cached and
 * replayed the same way.
 */
export async function resolveSubWorkflowActivity(
  _ctx: WorkflowActivityContext,
  rawInput: unknown
): Promise<ResolveSubWorkflowOutput> {
  const input = resolveSubWorkflowInputSchema.parse(rawInput);
  try {
    const {
      WorkflowRepository,
    }: { WorkflowRepository: typeof WorkflowRepositoryType } =
      await import('@n8n/db');
    const workflowRepository = Container.get(WorkflowRepository);
    const workflow = await workflowRepository.get({ id: input.workflowId });
    if (!workflow) {
      return {
        ok: false,
        message: `sub-workflow "${input.workflowId}" not found`,
      };
    }
    return {
      ok: true,
      nodes: workflow.nodes,
      connections: workflow.connections,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

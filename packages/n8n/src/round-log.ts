// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import type { WorkflowActivityContext } from '@diagrid/agent-core';

import { logRoundStartInputSchema } from './schemas';

/**
 * The ONE real, meaningfully different piece of orchestrator-v2's logic
 * versus v1 (see orchestrator-v2.ts's own top-of-file doc comment) — a real,
 * plausible observability improvement (round-by-round dispatch logging, not
 * just the final per-node markers activity.ts already has) that also
 * happens to be exactly the kind of change the versioning-discipline proof
 * needed: it adds a genuinely new `yield ctx.callActivity(...)` to the
 * orchestrator's sequence, at a position v1's already-recorded history has
 * nothing matching. See README's "Versioning discipline" section for the
 * real, run-and-observed proof this was built for.
 *
 * Deliberately NOT ledger-cached the way runN8nNodeActivity is: this has no
 * real side effect to deduplicate (a log line printed twice on redelivery is
 * harmless), same reasoning as resolveSubWorkflowActivity's own doc comment
 * on why IT skips the ledger too.
 */
export interface LogRoundStartInput {
  instanceId: string;
  round: number;
  nodeNames: string[];
}

// Async to match every other activity's signature (the SDK's own
// `TWorkflowActivity` contract), even though this specific implementation
// never awaits anything.
// eslint-disable-next-line @typescript-eslint/require-await
export async function runLogRoundStartActivity(
  _ctx: WorkflowActivityContext,
  rawInput: unknown
): Promise<{ ok: true }> {
  const input = logRoundStartInputSchema.parse(rawInput);
  console.log(
    `@diagrid/n8n (orchestrator-v2): instance ${input.instanceId} round ${input.round} ` +
      `dispatching [${input.nodeNames.join(', ')}]`
  );
  return { ok: true };
}

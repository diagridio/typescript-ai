// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import { WorkflowExecute } from 'n8n-core';
import type { Workflow } from 'n8n-workflow';

import { runDurably } from './run-durably';

// Module-level guard against double-patching within one loaded module instance.
// NOTE (unverified): n8n's worker_threads share an OS PID with their parent
// but get their own isolated module registry, so this guard only protects
// re-evaluation *within one such registry* — see runtime.ts for the same
// caveat on the runtime singleton.
let patched = false;

/** The actual patch. Exported (rather than applied as an import-time side
 * effect here) so it can be used programmatically — tests, a future opt-in/
 * opt-out flag — without necessarily triggering it just by importing this
 * module. See preload.ts for the file that's actually meant to be loaded via
 * `NODE_OPTIONS="--require @diagrid/n8n/register"`.
 */
export function register(): void {
  if (patched) return;
  patched = true;

  WorkflowExecute.prototype.processRunExecutionData = function (
    this: WorkflowExecute,
    workflow: Workflow
  ) {
    return runDurably(this, workflow) as never; // native return type is PCancelable<IRun> — TODO(n8n-integration): see run-durably.ts's cancellation gap
  };
}

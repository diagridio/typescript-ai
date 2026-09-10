// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Sibling of `n8n-crash-recovery.integration.test.ts`, and the harder proof
 * this package's own README already named but had not automated: killing
 * while a *sub-workflow's child* is mid-activity — not merely "the parent
 * has started but the child hasn't begun" — and proving no duplicate child
 * orchestration was created on resume. This is `n8n-dapr-durable`'s own
 * Phase 3 exit criterion (see that project's README: "the architectural trap
 * this phase is actually about"), automated for real rather than re-run by
 * hand.
 *
 * Shared setup (availability detection, process spawning helpers, polling,
 * the ledger check) lives in `n8n-helpers/process-harness.ts` — see the
 * sibling file's own top comment for why this suite needs its own
 * CI-availability detection and skip logic in the first place.
 *
 * ## Why the child needs its OWN direct state-store check, not just the parent's
 *
 * The architectural trap `sub-workflow.ts`'s own doc comment describes: real
 * n8n's `executeWorkflow()` mints a brand-new child execution id on every
 * call, with no way to pass an existing one in. If a crash mid-child were
 * handled by simply re-dispatching the Execute Workflow node from scratch,
 * the redelivered attempt would call `executeWorkflow()` again — allocating
 * a DIFFERENT child id and orphaning the first child's still-running
 * orchestration rather than resuming it. The fix (`orchestrator.ts`) is
 * dispatching the child as a real Dapr child workflow with no explicit
 * instance id, so the SDK derives one deterministically
 * (`${parentInstanceId}:${seq.toString(16).padStart(4,'0')}` — confirmed
 * against the real, pinned `@dapr/dapr` source during this package's own
 * verification pass) and a replay reaching the same call resolves the same
 * child. Proving that requires checking the child's OWN Dapr instance
 * directly — the parent's own execution record and n8n's REST API cannot
 * show whether a second, orphaned child orchestration exists somewhere in
 * Dapr's backing store; only the backing store itself can.
 *
 * ## The two direct-state checks this file performs, and why each is a real check
 *
 * 1. Before the kill: `workflowInstanceExists` confirms the CHILD's own Dapr
 *    workflow instance already has a record (created when the parent's
 *    `ctx.callChildWorkflow` was processed), while `ledgerKeyExists` for the
 *    child's own first node confirms that node's activity has NOT yet
 *    returned. Both together is what "genuinely mid-flight inside the
 *    child" means, as opposed to "the parent dispatched the child but
 *    nothing there has run yet" (which the ledger check alone would not
 *    distinguish from "the child hasn't started at all").
 * 2. After resume: `distinctChildInstanceIds` — a direct Redis scan of
 *    Dapr's own workflow-engine backing store (`workflows-state`, not the
 *    ledger's `kvstore` — see `process-harness.ts`'s own doc comment for the
 *    real key shape, confirmed by actually scanning it) for every instance
 *    whose id starts with `<parentExecutionId>:` — must return EXACTLY the
 *    one id discovered before the kill. This is the literal claim this
 *    scenario exists to prove, checked the same way `n8n-dapr-durable`'s own
 *    Phase 3 proof did it (a raw backing-store scan, bypassing this
 *    package's code and n8n's REST API both) — not inferred from the parent
 *    completing successfully, which a duplicate child could do too.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  N8N_CHECKOUT,
  PRELOAD_BUILT,
  HAS_DAPR,
  HAS_DOCKER_REDIS,
  BYPASS_SHIM,
  PRELOAD_CJS,
  RESOURCES_DIR,
  distinctChildInstanceIds,
  ledgerKeyExists,
  pollUntil,
  readLedgerValue,
  readMarkerLog,
  waitForLogLine,
  waitForLogMatch,
  workflowInstanceExists,
} from './n8n-helpers/process-harness.js';
import {
  N8nClient,
  type WorkflowDefinition,
} from './n8n-helpers/n8n-client.js';

const CAN_RUN =
  HAS_DAPR && HAS_DOCKER_REDIS && N8N_CHECKOUT !== undefined && PRELOAD_BUILT;

if (!CAN_RUN) {
  console.warn(
    '[n8n sub-workflow crash-recovery e2e] skipped — ' +
      `dapr CLI available: ${HAS_DAPR}, ` +
      `dapr_redis reachable via docker exec: ${HAS_DOCKER_REDIS}, ` +
      `sibling n8n checkout linked and built: ${N8N_CHECKOUT !== undefined}, ` +
      `packages/n8n built: ${PRELOAD_BUILT}. ` +
      'See packages/n8n/README.md "Developing against a local n8n checkout" ' +
      'to set this up; no CI lane provisions it today (see the sibling test ' +
      "file's own top-of-file comment for why that is a deliberate, not " +
      'accidental, gap). The extra `dapr_redis` requirement here (beyond the ' +
      "sibling test) is this scenario's own: proving no duplicate child " +
      "instance was created needs a direct scan of Dapr's backing store, " +
      'which an HTTP state read cannot do (it can only fetch a key you ' +
      'already know the name of).'
  );
}

/** See the sibling test file's own doc comment for why this must be unique per run. */
const APP_ID = `diagrid-n8n-it-sub-${process.pid}-${Date.now()}`;
/** Distinct from the sibling test's ports — belt and braces alongside `fileParallelism: false`. */
const DAPR_HTTP_PORT = 3712;
const DAPR_GRPC_PORT = 50412;
const DELAY_MS = 8_000;

const CHILD_WORKFLOW_NAME = 'diagrid-n8n-it-subworkflow-child';
const PARENT_WORKFLOW_NAME = 'diagrid-n8n-it-subworkflow-parent';
/** What Parent Set's own final value proves came from the child, not a placeholder. */
const CHILD_MARKER_VALUE = 'reached-from-child';

function setNode(
  name: string,
  id: string,
  field: string,
  value: string,
  x: number
) {
  return {
    id,
    name,
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position: [x, 0],
    parameters: {
      assignments: {
        assignments: [{ id: '1', name: field, type: 'string', value }],
      },
      includeOtherFields: true,
      options: {},
    },
  };
}

/**
 * Manual Trigger -> Child A -> Child B. Two real, activity-dispatched nodes
 * (the trigger itself is seeded, never dispatched — see
 * `OrchestrationInput.seed`'s own doc comment in packages/n8n/src/types.ts)
 * so "the child's first node" is a genuine mid-flight activity to kill, with
 * a second node downstream of it to prove the child itself resumes
 * correctly, not just the parent.
 */
function childWorkflowDefinition(): WorkflowDefinition {
  return {
    name: CHILD_WORKFLOW_NAME,
    nodes: [
      {
        id: 'sub-child-trigger',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      setNode('Child A', 'sub-child-a', 'childStepA', 'done', 220),
      setNode('Child B', 'sub-child-b', 'childField', CHILD_MARKER_VALUE, 440),
    ],
    connections: {
      'Manual Trigger': {
        main: [[{ node: 'Child A', type: 'main', index: 0 }]],
      },
      'Child A': { main: [[{ node: 'Child B', type: 'main', index: 0 }]] },
    },
    settings: {},
  };
}

function parentWorkflowDefinition(childWorkflowId: string): WorkflowDefinition {
  return {
    name: PARENT_WORKFLOW_NAME,
    nodes: [
      {
        id: 'sub-parent-trigger',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'sub-parent-execute',
        name: 'Execute Workflow',
        // typeVersion 1: workflowId is a plain string (source: 'database' is
        // the default at this version) — see sub-workflow.ts's own doc
        // comment on why only a literal id, no expressions, is supported.
        type: 'n8n-nodes-base.executeWorkflow',
        typeVersion: 1,
        position: [220, 0],
        parameters: { source: 'database', workflowId: childWorkflowId },
      },
      // A Set node, deliberately: proves the parent resumes past the child
      // and receives its real output, and its own name/type carries no risk
      // of colliding with any test-only node-type override (unlike a NoOp
      // node would — see regression.ts's own doc comment on exactly that
      // fixture-collision bug, found and fixed during this package's own
      // verification pass).
      {
        id: 'sub-parent-set',
        name: 'Parent Set',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [440, 0],
        parameters: {
          assignments: {
            assignments: [
              { id: '1', name: 'parentField', type: 'string', value: 'done' },
            ],
          },
          includeOtherFields: true,
          options: {},
        },
      },
    ],
    connections: {
      'Manual Trigger': {
        main: [[{ node: 'Execute Workflow', type: 'main', index: 0 }]],
      },
      'Execute Workflow': {
        main: [[{ node: 'Parent Set', type: 'main', index: 0 }]],
      },
    },
    settings: {},
  };
}

describe.skipIf(!CAN_RUN)('n8n sub-workflow crash recovery (e2e)', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'diagrid-n8n-it-sub-'));
  const n8nUserFolder = join(workDir, '.n8n');
  const markerFile = join(workDir, 'marker.log');
  const daprLog = join(workDir, 'dapr-sidecar.log');
  const n8nLogBeforeKill = join(workDir, 'n8n-before-kill.log');
  const n8nLogAfterRestart = join(workDir, 'n8n-after-restart.log');

  let daprProcess: ChildProcess | undefined;
  let n8nProcess: ChildProcess | undefined;

  function spawnN8n(logPath: string): ChildProcess {
    const logFd = openSync(logPath, 'a');
    const child = spawn(
      'node',
      [
        '--require',
        BYPASS_SHIM,
        '--require',
        PRELOAD_CJS,
        // Non-null: CAN_RUN (this describe block's own gate) already proved
        // N8N_CHECKOUT is defined; no-non-null-assertion is already off for
        // tests/**/*.ts, so no eslint-disable is needed here.
        N8N_CHECKOUT!.n8nBin,
        'start',
      ],
      {
        cwd: workDir,
        env: {
          ...process.env,
          // See n8n-crash-recovery.integration.test.ts's own doc comment for
          // why this override is real and load-bearing, not defensive
          // boilerplate: a real n8n process inheriting Vitest's own
          // NODE_ENV=test hangs silently right after connecting to Dapr.
          NODE_ENV: 'production',
          DAPR_HTTP_PORT: String(DAPR_HTTP_PORT),
          DAPR_GRPC_PORT: String(DAPR_GRPC_PORT),
          N8N_USER_FOLDER: n8nUserFolder,
          N8N_DIAGNOSTICS_ENABLED: 'false',
          DIAGRID_N8N_MARKER_FILE: markerFile,
          // Delays the CHILD's own first node, not anything in the parent —
          // maybeDelay (activity.ts) matches on node NAME alone, so this has
          // no effect on the parent's "Execute Workflow"/"Parent Set" nodes,
          // which are never named "Child A".
          DIAGRID_N8N_DELAY_NODE_NAME: 'Child A',
          DIAGRID_N8N_DELAY_MS: String(DELAY_MS),
        },
        stdio: ['ignore', logFd, logFd],
      }
    );
    n8nProcess = child;
    return child;
  }

  function killIfAlive(child: ChildProcess | undefined): void {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }

  beforeAll(async () => {
    console.log(`[n8n sub-workflow crash-recovery e2e] work dir: ${workDir}`);

    try {
      execFileSync('dapr', ['stop', '--app-id', APP_ID], { stdio: 'ignore' });
    } catch {
      // Nothing was running — expected on a clean run.
    }

    daprProcess = spawn(
      'dapr',
      [
        'run',
        '--app-id',
        APP_ID,
        '--resources-path',
        RESOURCES_DIR,
        '--dapr-http-port',
        String(DAPR_HTTP_PORT),
        '--dapr-grpc-port',
        String(DAPR_GRPC_PORT),
        '--',
        'sh',
        '-c',
        'while true; do sleep 3600; done',
      ],
      { stdio: ['ignore', openSync(daprLog, 'a'), openSync(daprLog, 'a')] }
    );

    await waitForLogLine(daprLog, "You're up and running", 30_000, 200);
  }, 60_000);

  afterAll(() => {
    killIfAlive(n8nProcess);
    try {
      execFileSync('dapr', ['stop', '--app-id', APP_ID], { stdio: 'ignore' });
    } catch {
      // Best-effort — `dapr run`'s own process is killed next regardless.
    }
    killIfAlive(daprProcess);
  });

  it('resumes a sub-workflow child killed mid-activity, with no duplicate child instance', async () => {
    // --- Boot #1 ---
    spawnN8n(n8nLogBeforeKill);
    await waitForLogLine(
      n8nLogBeforeKill,
      'Editor is now accessible',
      60_000,
      200
    );

    // --- Create both workflows and trigger the parent ---
    const client = new N8nClient('http://localhost:5678');
    await client.ensureLoggedIn();
    const childWorkflowId = await client.findOrCreateWorkflow(
      childWorkflowDefinition()
    );
    const parentWorkflowId = await client.findOrCreateWorkflow(
      parentWorkflowDefinition(childWorkflowId)
    );
    const parentExecutionId = await client.trigger(parentWorkflowId);

    // --- Discover the child's real Dapr instance id from the log itself —
    // not computed from the deterministic-suffix formula by hand, so this
    // test does not silently stop meaning anything the day an unrelated
    // change to the orchestrator's own call sequence shifts the suffix. ---
    const match = await waitForLogMatch(
      n8nLogBeforeKill,
      /instance ([\w:]+) round 0 dispatching \[Child A\]/,
      20_000,
      50
    );
    const childInstanceId = match[1];
    expect(childInstanceId).toBeDefined();
    // The deterministic shape this whole scenario depends on —
    // `${parentInstanceId}:${seq.toString(16).padStart(4,'0')}` — confirmed
    // against the real, pinned @dapr/dapr source during this package's own
    // verification pass.
    expect(childInstanceId).toMatch(
      new RegExp(`^${parentExecutionId}:[0-9a-f]{4}$`)
    );

    // --- The kill: block on the child's OWN round-start line, not a sleep ---
    const pidBeforeKill = n8nProcess?.pid;
    killIfAlive(n8nProcess);

    // --- Direct state-store confirmation: genuinely mid-flight INSIDE the
    // child, not merely "the parent started but the child hasn't begun" ---
    expect(
      workflowInstanceExists(APP_ID, childInstanceId!),
      `expected the child's own Dapr workflow instance (${childInstanceId}) to already exist`
    ).toBe(true);
    expect(
      await ledgerKeyExists(
        DAPR_HTTP_PORT,
        `diagrid.n8n:${childInstanceId}:Child A:0:1`
      ),
      "expected Child A's activity to still be genuinely in flight (no ledger entry yet)"
    ).toBe(false);
    const preKillMarkers = readMarkerLog(markerFile);
    // Execute Workflow never appears — it's handled by the orchestrator
    // itself, never dispatched through the generic activity (see
    // sub-workflow.ts's own doc comment).
    expect(preKillMarkers.map((m) => m.nodeName)).toEqual([]);

    // --- Boot #2: restart, zero manual trigger ---
    spawnN8n(n8nLogAfterRestart);
    await waitForLogLine(
      n8nLogAfterRestart,
      `Successfully connected to dns:127.0.0.1:${DAPR_GRPC_PORT}`,
      60_000,
      200
    );
    const pidAfterRestart = n8nProcess?.pid;
    expect(pidAfterRestart).not.toBe(pidBeforeKill);

    // --- Resume, polled with a bounded retry loop ---
    const execution = await pollUntil(
      async () => {
        const current = await client.getExecution(parentExecutionId);
        return current?.finished ? current : undefined;
      },
      90_000,
      2_000
    );

    // --- Real assertions on the real outcome ---
    expect(execution.status).toBe('success');

    const allMarkers = readMarkerLog(markerFile);
    expect(allMarkers.map((m) => m.nodeName).sort()).toEqual([
      'Child A',
      'Child B',
      'Parent Set',
    ]);
    const byNode = new Map(allMarkers.map((m) => [m.nodeName, m]));
    expect(byNode.size).toBe(3);
    // Child A is the node killed genuinely mid-flight — by construction it
    // can never have completed before the kill (that is the entire point
    // of blocking on its own round-start line first), so its one real
    // execution is necessarily on the NEW process, exactly like Child B
    // and Parent Set, which never even started until after resume. This
    // mirrors the sibling test's Set A/Set B (pidBeforeKill) vs Set C
    // (pidAfterRestart) split — the difference here is that NOTHING in
    // this scenario completes before the kill, since Child A is this
    // scenario's own "Set C".
    expect(byNode.get('Child A')?.pid).toBe(pidAfterRestart);
    expect(byNode.get('Child B')?.pid).toBe(pidAfterRestart);
    expect(byNode.get('Parent Set')?.pid).toBe(pidAfterRestart);
    expect(allMarkers.every((m) => m.status === 'success')).toBe(true);

    // Ledger: exactly the entries this run should have produced, keyed
    // under the CHILD's own instance id, no more.
    for (const node of ['Child A', 'Child B']) {
      expect(
        await ledgerKeyExists(
          DAPR_HTTP_PORT,
          `diagrid.n8n:${childInstanceId}:${node}:0:1`
        ),
        `expected a ledger entry for ${node}`
      ).toBe(true);
    }

    // --- THE core claim this scenario exists to prove: a direct scan of
    // Dapr's own backing store shows exactly the one child instance
    // discovered before the kill — no second, orphaned orchestration was
    // created by the redelivered "Execute Workflow" node re-resolving a
    // new child. Logged, not just asserted: this exact line is the
    // evidence a human re-running this test is meant to be able to read
    // directly, mirroring how n8n-dapr-durable's own Phase 3 proof quoted
    // its own redis scan verbatim rather than only asserting on it. ---
    const children = distinctChildInstanceIds(APP_ID, parentExecutionId);
    console.log(
      `[n8n sub-workflow crash-recovery e2e] direct Dapr backing-store scan for ` +
        `parent ${parentExecutionId}: found child instance id(s) ${JSON.stringify(children)} ` +
        `(discovered before the kill: ${JSON.stringify([childInstanceId])})`
    );
    expect(
      children,
      `expected exactly one child instance for parent ${parentExecutionId}, found: ${JSON.stringify(children)}`
    ).toEqual([childInstanceId]);

    // The parent genuinely received the child's real output, not a
    // placeholder: Parent Set's OWN ledger entry (keyed under the
    // PARENT's instance id, unlike the child-node checks above) is real
    // state this package produced only if Child B's real value actually
    // crossed the child->parent boundary through the orchestrator's own
    // data plumbing — read directly, the same way the rest of this file's
    // evidence is gathered, rather than searching n8n's own REST response
    // (whose `data` field is a `flatted`-compressed blob that does not
    // embed leaf values as plain, greppable substrings — confirmed
    // directly; an earlier version of this check tried exactly that and
    // it did not find a value known to be present).
    const parentSetOutput = await readLedgerValue(
      DAPR_HTTP_PORT,
      `diagrid.n8n:${parentExecutionId}:Parent Set:0:1`
    );
    const parentSetJson = (
      parentSetOutput as { outputItems?: Array<Array<{ json?: unknown }>> }
    )?.outputItems?.[0]?.[0]?.json as Record<string, unknown> | undefined;
    expect(parentSetJson?.['childField']).toBe(CHILD_MARKER_VALUE);
    expect(parentSetJson?.['parentField']).toBe('done');
  }, 180_000);
});

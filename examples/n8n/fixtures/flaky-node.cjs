'use strict';
// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1
//
// Test-only node type for exercising the orchestrator's retry loop end to
// end — ported from n8n-dapr-durable's own test/flaky-node.js. None of the
// real node types this package wires up (Set/NoOp/If/Merge/Wait) ever fail on
// their own, so there's no way to observe retry/backoff behavior without
// manufacturing a failure — this is that manufactured failure.
//
// Registered under the KEY 'n8n-nodes-base.noOp', not a made-up type name —
// deliberately overriding the real NoOp entry in execute-node.ts's
// SUPPORTED_NODE_TYPES (via the Object.assign there) rather than inventing a
// new one. n8n's own pre-execution validation rejects any `node.type` it
// doesn't recognize from the real, installed node registry long before this
// package's own patch ever runs, so a genuinely novel type name can't be
// exercised through a real manual-run API call without also registering it
// as a real n8n custom-extension package. Reusing NoOp's name sidesteps that:
// the workflow's node is typed "n8n-nodes-base.noOp" (which n8n recognizes
// fine), and only THIS process's own execute-node.ts dispatch (which decides
// what code actually runs for that name) is redirected to this class instead
// — exactly the layer under test. Only takes effect when
// DIAGRID_N8N_TEST_NODE_TYPES_MODULE points at this file; every other process
// still gets the real NoOp.
//
// Deliberately plain CommonJS (not TypeScript): not part of this package's
// public build (packages/n8n's tsconfig only includes its own src/**), and
// simple enough that a separate compile step is pure overhead. `execute()`
// still follows the same this-bound legacy-node calling convention as the
// real node types (see execute-node.ts) — `this` is the ExecuteContext, not a
// parameter.
//
// Failure/counting is keyed purely by "how many times execute() ran for
// real" (ledger misses only — activity.ts never calls this on a ledger hit):
// a real retry/backoff advances this counter; a redelivered-but-already-
// recorded attempt never reaches this file at all.

const fs = require('fs');

function readCount(counterFile) {
  try {
    const raw = fs.readFileSync(counterFile, 'utf8').trim();
    return raw ? parseInt(raw, 10) : 0;
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
}

class Flaky {
  constructor() {
    this.description = {
      displayName: 'Flaky (test-only)',
      name: 'noOp', // matches the real NoOp's description.name — see the file-level comment
      icon: 'node:no-operation',
      iconColor: 'red',
      group: ['organization'],
      version: 1,
      description:
        '@diagrid/n8n test-only node: throws on its first N real invocations, then succeeds.',
      defaults: { name: 'Flaky' },
      inputs: ['main'],
      outputs: ['main'],
      properties: [],
    };
  }

  // this-bound (see execute-node.ts's isNodeClassInstance dispatch) — no
  // parameters, matches the real node types' calling convention exactly.
  async execute() {
    const counterFile = process.env.DIAGRID_N8N_FLAKY_COUNTER_FILE;
    if (!counterFile) {
      throw new Error(
        '@diagrid/n8n test fixture: DIAGRID_N8N_FLAKY_COUNTER_FILE must be set.'
      );
    }
    const failCount = parseInt(
      process.env.DIAGRID_N8N_FLAKY_FAIL_COUNT || '2',
      10
    );

    const attemptNumber = readCount(counterFile) + 1;
    fs.writeFileSync(counterFile, String(attemptNumber));

    if (attemptNumber <= failCount) {
      throw new Error(
        `@diagrid/n8n test fixture: deliberate failure on real invocation #${attemptNumber} ` +
          `(configured to fail the first ${failCount})`
      );
    }

    const items = this.getInputData();
    return [items];
  }
}

module.exports = {
  'n8n-nodes-base.noOp': () => Flaky,
};

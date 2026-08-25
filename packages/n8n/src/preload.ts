// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

// The file NODE_OPTIONS="--require @diagrid/n8n/register" actually loads (see
// package.json's "exports" map, which points the "./register" subpath at
// this file's compiled output). Kept separate from register.ts so the patch
// function itself has no import-time side effect and can be imported
// programmatically without necessarily triggering it.
import { isMainThread } from 'node:worker_threads';

import { register } from './register';
import { getRuntime, registerShutdownHandlers } from './runtime';

register();

// Start the Dapr workflow runtime eagerly, at process boot — not lazily on
// first execution. Dapr's own actor-based redelivery already reconnects to
// incomplete instances automatically once a runtime is live; starting it
// late just means there's nothing listening yet to receive that redelivery
// right after a crash-and-restart.
//
// isMainThread-gated: confirmed empirically (DIAGRID_N8N_RUNTIME_DEBUG_LOG
// under a real `n8n start` boot, in earlier phases of this package's
// development) that NODE_OPTIONS is inherited by at least one worker_thread
// n8n itself spins up during its own startup. That thread never executes
// `processRunExecutionData` — this preload script making the *eager* call
// unconditionally is what created a second, pointless runtime + sidecar
// connection, not any real workflow execution reaching it — so gating eager
// start to the main thread avoids a real, observed duplicate connection with
// zero loss of durability. `getRuntime()` itself (called lazily from
// runDurably) is deliberately NOT gated the same way: if some future/other
// n8n execution model ever did drive a real execution from a worker_thread,
// that thread still needs to be able to stand up its own runtime on demand.
//
// `getRuntime()` is async now (a dynamic `await import('@dapr/dapr')` inside
// it — see runtime.ts's own doc comment for why), so the eager call here is
// deliberately NOT awaited: a `--require` preload script runs synchronously
// and must not block the rest of n8n's own boot on a Dapr sidecar connection.
// A rejection is caught and logged rather than left as an unhandled
// rejection, which would crash the process on Node >= 15.
if (isMainThread) {
  void getRuntime().catch((err: unknown) => {
    console.error(
      '@diagrid/n8n: failed to start the Dapr workflow runtime',
      err
    );
  });
  registerShutdownHandlers();
}

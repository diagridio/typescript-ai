'use strict';
// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1
//
// Dev-machine-only compatibility shim, committed (unlike
// n8n-dapr-durable's own test/node-version-bypass.js, which stayed local)
// so n8n-crash-recovery.integration.test.ts can actually run on a developer
// machine that has Node <24 on PATH — n8n's own package.json requires
// ">=24.0.0" and bin/n8n process.exit(1)s before this package's code (or
// this test) ever runs otherwise.
//
// Intercepts exactly n8n's own `require('semver/functions/satisfies')` call
// and makes it always return true. Provably a no-op wherever it doesn't
// matter: a real Node >=24 already satisfies that range on its own, so this
// changes nothing there — it only changes the outcome on an older Node,
// which is the one case this test needs to run at all. Not part of
// @diagrid/n8n's own shipped behavior (see packages/n8n/src/preload.ts) —
// this is test-harness-only, loaded via --require ahead of the real preload,
// exactly like n8n-dapr-durable's DEMO.md walkthrough did.
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'semver/functions/satisfies') {
    return () => true;
  }
  return originalRequire.apply(this, arguments);
};

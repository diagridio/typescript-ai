// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Test setup for the `unit` project only.
 *
 * The `integration` project deliberately declares no setup file: scrubbing
 * `DAPR_*` and `OTEL_*` is exactly wrong there, because those variables are how
 * an integration run is configured. See the comment in `vitest.config.ts`.
 *
 * The Python sibling's `tests/agent/conftest.py` exists mainly to stop
 * `DaprClient` from blocking 60s on a missing sidecar. The TypeScript SDK has
 * no equivalent health-check wait, so the job here is narrower: keep the
 * ambient environment deterministic, since several modules read `OTEL_*` and
 * `DAPR_*` at call time and a developer's shell should not change test
 * outcomes.
 */

import { afterEach, beforeEach } from 'vitest';

/** Env vars that leak developer/CI configuration into unit tests. */
const MANAGED_ENV_VARS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_SERVICE_NAME',
  'DAPR_HOST',
  'DAPR_GRPC_PORT',
  'DAPR_API_TOKEN',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(
    MANAGED_ENV_VARS.map((key) => [key, process.env[key]])
  );
  for (const key of MANAGED_ENV_VARS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

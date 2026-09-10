// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Sidecar detection, reused from `examples/mastra/sidecar.ts` — the same
 * shape applies unchanged: `@dapr/dapr` itself reads `DAPR_GRPC_ENDPOINT`/
 * `DAPR_API_TOKEN` (Catalyst) or `DAPR_GRPC_PORT` (local `dapr run`) from the
 * environment, so a preflight check has to accept either shape rather than
 * hardcoding one.
 *
 * One real difference from the mastra example, stated plainly: this package
 * attaches to n8n itself as a separate SERVER PROCESS (via `NODE_OPTIONS
 *="--require @diagrid/n8n/register"`), not as a library an example script
 * constructs and calls `.invoke()` on in-process. So unlike
 * `examples/mastra/crash-recovery.ts` (which injects its own crash via
 * `process.exit(1)` and re-runs itself), this example cannot start, crash, or
 * restart n8n from within a TypeScript script — that's an external,
 * shell-level step, documented in this directory's own README. What this
 * script (and crash-recovery.ts) verify is the same sidecar-reachable
 * precondition mastra's own examples do.
 */

export type SidecarMode = 'local' | 'catalyst' | 'none';

export function detectSidecar(): SidecarMode {
  if (process.env['DAPR_GRPC_ENDPOINT']) {
    return 'catalyst';
  }
  if (process.env['DAPR_GRPC_PORT']) {
    return 'local';
  }
  return 'none';
}

export function describeSidecar(mode: SidecarMode): string {
  switch (mode) {
    case 'catalyst':
      return `Diagrid Catalyst (${process.env['DAPR_GRPC_ENDPOINT']})`;
    case 'local':
      return `local Dapr sidecar (grpc port ${process.env['DAPR_GRPC_PORT']})`;
    case 'none':
      return 'no sidecar';
  }
}

export function runCommands(appId: string): string {
  return (
    `  # Local Dapr (components from ./resources) — a genuinely long-lived\n` +
    `  # placeholder command: n8n runs in its OWN separate terminal (see README),\n` +
    `  # not as the "app" dapr run launches, so a killed-and-restarted n8n can\n` +
    `  # find the same sidecar again.\n` +
    `  dapr run --app-id ${appId} --resources-path ./resources \\\n` +
    `    --dapr-http-port 3610 --dapr-grpc-port 50310 -- sh -c 'while true; do sleep 3600; done'\n\n` +
    `  # Diagrid Catalyst (components from the Catalyst project)\n` +
    `  diagrid dev run --app-id ${appId} -- sh -c 'while true; do sleep 3600; done'`
  );
}

export function requireSidecar(appId: string): SidecarMode {
  const mode = detectSidecar();
  if (mode !== 'none') {
    return mode;
  }

  console.error(
    `This example requires a Dapr sidecar. Run it one of these two ways:\n\n` +
      `${runCommands(appId)}\n\n` +
      `For local Dapr, run "dapr init" first (needs Docker).\n` +
      `For Catalyst, create a project with:\n` +
      `  diagrid project create <name> --deploy-managed-kv --deploy-managed-pubsub --enable-managed-workflow --use\n\n` +
      `Then start n8n itself, patched, in a separate terminal — see README.md.`
  );
  process.exit(1);
}

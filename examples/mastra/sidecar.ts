// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Sidecar detection shared by the examples.
 *
 * Every example runs two ways, and they are configured differently:
 *
 * - **Local Dapr** (`dapr run`) — a sidecar on localhost. Sets `DAPR_GRPC_PORT`,
 *   and components come from the on-disk `./resources` directory.
 * - **Diagrid Catalyst** (`diagrid dev run`) — a managed, remote sidecar. Sets
 *   `DAPR_GRPC_ENDPOINT` (remote, TLS) and `DAPR_API_TOKEN`; components live in
 *   the Catalyst project, so there is no `--resources-path`.
 *
 * Detecting only `DAPR_GRPC_PORT` would therefore reject a perfectly good
 * Catalyst run. `@dapr/dapr` itself reads all of these from the environment
 * (`generateEndpoint()` / `getDaprApiToken()`), which is why the adapter needs no
 * Catalyst-specific code — but a preflight check has to accept either shape.
 *
 * Without this check, starting the workflow runtime with no sidecar fails deep
 * inside gRPC with `ECONNREFUSED 127.0.0.1:50001` and a stack trace through
 * `@grpc/grpc-js`, which reads like a broken install rather than a missing
 * `dapr run`.
 */

/** How the process is connected to Dapr, if at all. */
export type SidecarMode = 'local' | 'catalyst' | 'none';

/**
 * Detect which run path this process is on.
 *
 * Catalyst is checked first: `diagrid dev run` may set both variables when it
 * also opens a local app connection, and in that case the remote endpoint is the
 * one that matters.
 */
export function detectSidecar(): SidecarMode {
  if (process.env['DAPR_GRPC_ENDPOINT']) {
    return 'catalyst';
  }
  if (process.env['DAPR_GRPC_PORT']) {
    return 'local';
  }
  return 'none';
}

/** One-line description of the detected connection, for a script's output. */
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

/**
 * The two ways to run an example, as copy-pasteable commands.
 *
 * Kept in one place so every script — and the error message below — stays
 * consistent with the READMEs.
 */
export function runCommands(appId: string, script: string): string {
  return (
    `  # Local Dapr (components from ./resources)\n` +
    `  dapr run --app-id ${appId} --resources-path ./resources -- pnpm ${script}\n\n` +
    `  # Diagrid Catalyst (components from the Catalyst project)\n` +
    `  diagrid dev run --app-id ${appId} -- pnpm ${script}`
  );
}

/** Exit with an actionable message unless a sidecar — either kind — is attached. */
export function requireSidecar(appId: string, script: string): SidecarMode {
  const mode = detectSidecar();
  if (mode !== 'none') {
    return mode;
  }

  console.error(
    `This example requires a Dapr sidecar. Run it one of these two ways:\n\n` +
      `${runCommands(appId, script)}\n\n` +
      `For local Dapr, run "dapr init" first (needs Docker).\n` +
      `For Catalyst, create a project with:\n` +
      `  diagrid project create <name> --enable-agent-infrastructure --use`
  );
  process.exit(1);
}

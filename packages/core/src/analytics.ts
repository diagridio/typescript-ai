// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Anonymous usage reporting for `@diagrid/agent-core` and its adapters.
 *
 * Port of `diagrid/core/analytics.py` in the sibling `diagridio/python-ai`
 * repo. npm publishes aggregate download counts only. This module reports one
 * event per package per process with the package version and the host
 * platform, so Diagrid can see which versions run, and where. No application
 * data is collected. See the "Usage analytics" section of
 * `packages/core/README.md`, including how to opt out.
 *
 * One event per process means one event per replica per restart on
 * Kubernetes. The numbers count process starts, not deployments or users.
 *
 * `reportUsage` never blocks and never throws: it returns synchronously and
 * the network request runs in the background, unawaited by the caller. Every
 * failure — a bad URL, a rejected fetch, a timeout, an unexpected exception in
 * a helper — is swallowed. The one-second abort timer is `unref()`'d so it can
 * never by itself keep the process alive; a pending `fetch()` call is not
 * unref'd, so it can still hold the event loop open for up to that one second
 * on a process that would otherwise already have exited. Blocked egress and
 * air-gapped clusters are normal conditions, not faults.
 *
 * The endpoint has no public override: the only way to silence this module
 * from outside the package is one of the three opt-out environment variables
 * below. `__setEndpointForTests` is a test-only escape hatch, not re-exported
 * from `./index.ts`.
 */

import { debuglog } from 'node:util';

import { VERSION } from './version';

/** `NODE_DEBUG=diagrid:analytics` turns on send/skip/failure traces. */
const debug = debuglog('diagrid:analytics');

/** Identifies this module in the `User-Agent` header of every event. */
const REPORTER_PACKAGE_NAME = '@diagrid/agent-core';

/**
 * Scarf event-collection route for `typescript-ai` (owner Diagrid). The route
 * records the request and redirects nowhere. An empty endpoint disables
 * reporting entirely — see `__setEndpointForTests`.
 */
const DEFAULT_ENDPOINT = 'https://diagrid.gateway.scarf.sh/typescript-ai';
let endpoint = DEFAULT_ENDPOINT;

/** Bounds how long the background request can hold the event loop open. */
export const USAGE_TIMEOUT_MS = 1000;

/** Longest a single dimension value may be, after trimming. */
export const DIMENSION_MAX_LEN = 64;

/**
 * The cross-ecosystem `DO_NOT_TRACK` convention, Scarf's own variable, and a
 * Diagrid-specific opt-out. Any of them set to a truthy value disables
 * reporting.
 */
export const OPT_OUT_ENV_VARS = [
  'DO_NOT_TRACK',
  'SCARF_NO_ANALYTICS',
  'DIAGRID_NO_ANALYTICS',
] as const;

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);

/** `CI` is the convention most vendors follow. */
export const CI_TRUTHY_ENV_VARS = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'TF_BUILD',
] as const;

/** Vendors that set a value rather than a flag. Presence is enough. */
export const CI_PRESENCE_ENV_VARS = ['BUILDKITE', 'JENKINS_URL'] as const;

/** The Dapr SDK variables that point a process at Catalyst. */
export const DAPR_ENDPOINT_ENV_VARS = [
  'DAPR_GRPC_ENDPOINT',
  'DAPR_HTTP_ENDPOINT',
] as const;

const CATALYST_HOST_SUFFIX = 'diagrid.io';

/** Maps a Node platform to the label the model (`platform.system().lower()`) reports. */
const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  win32: 'windows',
};

/** Extra query-string dimensions a caller of {@link reportUsage} may supply. */
export type UsageDimensions = Record<
  string,
  string | number | boolean | null | undefined
>;

function isTruthy(value: string): boolean {
  return TRUTHY_VALUES.has(value.trim().toLowerCase());
}

/** Whether the user opted out through any supported environment variable. */
export function usageReportingDisabled(): boolean {
  return OPT_OUT_ENV_VARS.some((name) => isTruthy(process.env[name] ?? ''));
}

/**
 * Whether a well-known CI variable is set.
 *
 * Reported as the `ci` dimension so pipeline runs can be separated from real
 * usage on the dashboard.
 */
export function isRunningInCi(): boolean {
  if (CI_TRUTHY_ENV_VARS.some((name) => isTruthy(process.env[name] ?? ''))) {
    return true;
  }
  return CI_PRESENCE_ENV_VARS.some(
    (name) => (process.env[name] ?? '').trim() !== ''
  );
}

/** The hostname of `value`, or `''` when it does not parse as a URL. */
function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * `catalyst` when the process points at Diagrid Catalyst, else `dapr`.
 *
 * Catalyst is configured through the Dapr SDK variables: the endpoint host is
 * under `diagrid.io`, and Catalyst issues `DAPR_API_TOKEN`. A self-hosted
 * sidecar with API token authentication also reads as `catalyst`. That is an
 * approximation, and the dashboard reads it as one.
 */
export function detectTarget(): 'catalyst' | 'dapr' {
  for (const name of DAPR_ENDPOINT_ENV_VARS) {
    const host = hostnameOf((process.env[name] ?? '').trim());
    if (
      host === CATALYST_HOST_SUFFIX ||
      host.endsWith(`.${CATALYST_HOST_SUFFIX}`)
    ) {
      return 'catalyst';
    }
  }
  if ((process.env['DAPR_API_TOKEN'] ?? '').trim()) {
    return 'catalyst';
  }
  return 'dapr';
}

function detectOs(): string {
  return (PLATFORM_LABELS[process.platform] ?? process.platform).toLowerCase();
}

function cleanDimension(value: NonNullable<UsageDimensions[string]>): string {
  return String(value).trim().slice(0, DIMENSION_MAX_LEN);
}

/**
 * Build the event URL for `pkg`. Exposed for tests.
 *
 * The defaults describe the package and the host. `dimensions` are added by
 * the caller (for example `kind` and `framework`) and override a default of
 * the same name. Empty, `null` or `undefined` values are dropped.
 */
export function buildUrl(
  pkg: string,
  dimensions: UsageDimensions = {}
): string {
  const params: Record<string, string> = {
    package: pkg,
    version: VERSION,
    os: detectOs(),
    arch: process.arch,
    node_version: process.version.replace(/^v/, ''),
    target: detectTarget(),
    ci: isRunningInCi() ? 'true' : 'false',
  };

  for (const [key, value] of Object.entries(dimensions)) {
    if (value === undefined || value === null) {
      continue;
    }
    const cleaned = cleanDimension(value);
    if (cleaned) {
      params[key] = cleaned;
    }
  }

  return `${endpoint}?${new URLSearchParams(params).toString()}`;
}

/** Send one event and swallow every failure. */
async function sendEvent(
  pkg: string,
  dimensions: UsageDimensions
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
  // Never holds the process open by itself — see this file's own module doc.
  timer.unref();

  try {
    await fetch(buildUrl(pkg, dimensions), {
      signal: controller.signal,
      headers: { 'User-Agent': `${REPORTER_PACKAGE_NAME}/${VERSION}` },
    });
    debug('usage event sent for %s %s', pkg, VERSION);
  } catch (error) {
    debug('usage event for %s not sent: %s', pkg, String(error));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @internal Test seam only. Never re-exported from `./index.ts`.
 *
 * `usageReportingDisabled` is already directly callable in tests; this
 * indirection exists only so a test can simulate an unexpected failure inside
 * {@link reportUsage}'s own guarded body. ESM export bindings are read-only
 * from outside the module, so replacing the export itself would not change
 * what the bare call below resolves to — routing the call through a plain
 * object property does.
 */
export const internal = {
  usageReportingDisabled,
};

const reportedPackages = new Set<string>();

/**
 * Report one usage event per package per process, fire-and-forget.
 *
 * `pkg` is the package that triggered the call, for example
 * `@diagrid/agent-core` for an agent runner. `dimensions` are extra query
 * parameters such as `kind` and `framework`. Never blocks the caller and
 * never throws. Does nothing while the endpoint is empty or when the user
 * opted out.
 */
export function reportUsage(
  pkg: string,
  dimensions: UsageDimensions = {}
): void {
  try {
    if (!endpoint) {
      return;
    }
    if (reportedPackages.has(pkg)) {
      return;
    }
    reportedPackages.add(pkg);

    if (internal.usageReportingDisabled()) {
      debug('usage reporting for %s is disabled by the environment', pkg);
      return;
    }

    // Fire-and-forget: sendEvent already swallows its own failures, and this
    // `catch` is only a backstop against a future change to it that lets one
    // through — a caller of reportUsage must never see a rejection either way.
    void sendEvent(pkg, dimensions).catch(() => undefined);
  } catch {
    // Never throw out of the reporter.
  }
}

/** @internal Test-only. Empty disables reporting; restore before the suite ends. */
export function __setEndpointForTests(value: string): void {
  endpoint = value;
}

/** @internal Test-only. Clears the per-process "already reported" guard. */
export function __resetReportedPackagesForTests(): void {
  reportedPackages.clear();
}

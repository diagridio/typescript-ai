// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * OpenTelemetry setup shared by every framework runner.
 *
 * Key design decisions, carried over from `diagrid/agent/core/telemetry.py`
 * in `diagridio/python-ai`:
 *
 * - Uses the **standard OTel SDK** so framework-native instrumentation
 *   (Mastra's own telemetry, AI SDK spans, …) can layer on top of — or
 *   instead of — the global `TracerProvider`.
 * - **No-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset**, so local dev "just
 *   works" without a collector. `getTracer()` still returns a usable tracer;
 *   it is simply backed by the API's no-op provider.
 * - Uses the **gRPC OTLP exporter**, matching the collector endpoint
 *   (`:4317`) that dapr-agents already exports to successfully.
 * - The SDK is loaded through a dynamic `import()` so a process that never
 *   configures an endpoint never pays for constructing it.
 *
 * `tests/guards/telemetry-compat.test.ts` pins both the resolution
 * precedence below and the upstream `@opentelemetry/*` surface this module
 * depends on, so a Dependabot bump that moves either fails in seconds
 * instead of silently disabling tracing in production.
 */

import type { Metadata } from '@grpc/grpc-js';
import { trace, type Tracer } from '@opentelemetry/api';

export const OTEL_ENDPOINT_ENV = 'OTEL_EXPORTER_OTLP_ENDPOINT';
export const OTEL_SERVICE_NAME_ENV = 'OTEL_SERVICE_NAME';

/** Signal-specific suffixes the OTLP/HTTP convention appends to endpoints. */
const SIGNAL_SUFFIXES = ['/v1/traces', '/v1/metrics', '/v1/logs'] as const;

/**
 * Resolved observability settings for a runner.
 *
 * Mirrors dapr-agents' `AgentObservabilityConfig`: explicit configuration
 * wins over the environment, and `enabled: false` disables tracing outright
 * even when an endpoint is present.
 */
export interface ObservabilityConfig {
  readonly enabled?: boolean;
  readonly endpoint?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly serviceName?: string;
}

/** Handle returned by {@link setupTelemetry} when tracing is wired up. */
export interface TelemetryHandle {
  readonly serviceName: string;
  readonly endpoint: string;
  /** Flush pending spans and tear the provider down. */
  shutdown(): Promise<void>;
}

/**
 * Return the OTLP gRPC endpoint from config or environment, or `undefined`.
 *
 * Precedence: `config.endpoint` > `OTEL_EXPORTER_OTLP_ENDPOINT`. A
 * `config.enabled === false` short-circuits to `undefined`. Any signal path
 * suffix is stripped, because the gRPC exporter wants the bare `host:port`
 * rather than the HTTP `/v1/traces` path.
 */
export function resolveOtlpEndpoint(
  config?: ObservabilityConfig
): string | undefined {
  if (config?.enabled === false) {
    return undefined;
  }

  const raw = config?.endpoint ?? process.env[OTEL_ENDPOINT_ENV];
  if (!raw) {
    return undefined;
  }

  let endpoint = raw.replace(/\/+$/, '');
  for (const suffix of SIGNAL_SUFFIXES) {
    if (endpoint.endsWith(suffix)) {
      endpoint = endpoint.slice(0, -suffix.length);
      break;
    }
  }

  return endpoint || undefined;
}

/** Extract OTLP headers from config, or `undefined` when none are set. */
export function resolveOtlpHeaders(
  config?: ObservabilityConfig
): Record<string, string> | undefined {
  if (!config?.headers) {
    return undefined;
  }
  const headers = { ...config.headers };
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Resolve the service name reported on spans.
 *
 * Precedence: `config.serviceName` > `OTEL_SERVICE_NAME` > `fallback`.
 */
export function resolveServiceName(
  fallback: string,
  config?: ObservabilityConfig
): string {
  return config?.serviceName ?? process.env[OTEL_SERVICE_NAME_ENV] ?? fallback;
}

/**
 * Wire up a `NodeTracerProvider` exporting over OTLP/gRPC.
 *
 * Returns `undefined` — a deliberate no-op — when no endpoint is configured.
 * Callers must treat that as success: it is the normal local-dev path, not an
 * error.
 */
export async function setupTelemetry(
  serviceName: string,
  config?: ObservabilityConfig
): Promise<TelemetryHandle | undefined> {
  const endpoint = resolveOtlpEndpoint(config);
  if (!endpoint) {
    return undefined;
  }

  const resolvedServiceName = resolveServiceName(serviceName, config);
  const headers = resolveOtlpHeaders(config);

  // TODO(mastra-adapter): decide whether to own the global provider or defer
  // to a provider the host application already registered. Today we register
  // ours only when nothing else has, so a Mastra app that sets up its own
  // OTel pipeline keeps its configuration. Revisit once the adapter emits its
  // own spans and we know whether the two providers need to be merged.
  const [
    { NodeTracerProvider, BatchSpanProcessor },
    { OTLPTraceExporter },
    { resourceFromAttributes },
    { ATTR_SERVICE_NAME },
  ] = await Promise.all([
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/exporter-trace-otlp-grpc'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
  ]);

  // The OTLP/gRPC exporter carries per-request headers as gRPC metadata, not
  // as an HTTP header map, so `@grpc/grpc-js` is only loaded when headers are
  // actually configured (the common case — a local collector — needs none).
  let metadata: Metadata | undefined;
  if (headers) {
    const { Metadata: GrpcMetadata } = await import('@grpc/grpc-js');
    metadata = new GrpcMetadata();
    for (const [key, value] of Object.entries(headers)) {
      metadata.set(key, value);
    }
  }

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: resolvedServiceName,
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter(
          metadata ? { url: endpoint, metadata } : { url: endpoint }
        )
      ),
    ],
  });

  provider.register();

  return {
    serviceName: resolvedServiceName,
    endpoint,
    shutdown: async () => {
      await provider.shutdown();
    },
  };
}

/**
 * Return a tracer for `name`.
 *
 * Always safe to call: with no provider registered the OTel API hands back a
 * no-op tracer whose spans are inert, so instrumentation code never needs to
 * branch on whether telemetry is configured.
 */
export function getTracer(name: string, version?: string): Tracer {
  return trace.getTracer(name, version);
}

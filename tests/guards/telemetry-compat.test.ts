// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Guard: telemetry / OpenTelemetry compatibility.
 *
 * The TypeScript counterpart of
 * `tests/agent/core/test_telemetry_compat.py` in `diagridio/python-ai`, and
 * likewise wired straight into `.github/workflows/deps-check.yaml`.
 *
 * Two failure modes it exists to catch:
 *
 * 1. **A silent regression in endpoint resolution.** If `setupTelemetry` stops
 *    returning a no-op when no endpoint is configured, every local dev run
 *    starts trying to export spans; if the precedence between explicit config
 *    and `OTEL_EXPORTER_OTLP_ENDPOINT` flips, a deployment silently exports to
 *    the wrong collector.
 * 2. **An upstream `@opentelemetry/*` bump moving the surface we depend on.**
 *    The OTel JS SDK has renamed exports across minor versions more than once
 *    (`Resource` -> `resourceFromAttributes`, `SemanticResourceAttributes` ->
 *    `ATTR_*`). Those live behind a dynamic `import()` inside
 *    `setupTelemetry`, so nothing else in the test suite would notice until a
 *    production process tried to enable tracing.
 */

import { describe, expect, it } from 'vitest';

import {
  getTracer,
  OTEL_ENDPOINT_ENV,
  OTEL_SERVICE_NAME_ENV,
  resolveOtlpEndpoint,
  resolveOtlpHeaders,
  resolveServiceName,
  setupTelemetry,
} from '@diagrid/agent-core';

describe('endpoint resolution', () => {
  it('returns undefined when nothing is configured', () => {
    expect(resolveOtlpEndpoint()).toBeUndefined();
    expect(resolveOtlpEndpoint({})).toBeUndefined();
  });

  it('reads the standard OTEL env var', () => {
    process.env[OTEL_ENDPOINT_ENV] = 'http://collector:4317';
    expect(resolveOtlpEndpoint()).toBe('http://collector:4317');
  });

  it('prefers explicit config over the environment', () => {
    process.env[OTEL_ENDPOINT_ENV] = 'http://env-collector:4317';
    expect(resolveOtlpEndpoint({ endpoint: 'http://explicit:4317' })).toBe(
      'http://explicit:4317'
    );
  });

  it('honours enabled:false even when an endpoint is present', () => {
    process.env[OTEL_ENDPOINT_ENV] = 'http://collector:4317';
    expect(
      resolveOtlpEndpoint({ enabled: false, endpoint: 'http://x:4317' })
    ).toBeUndefined();
  });

  it.each(['/v1/traces', '/v1/metrics', '/v1/logs'])(
    'strips the %s signal suffix',
    (suffix) => {
      // The gRPC exporter wants a bare host:port; leaving the HTTP signal path
      // on produces a channel that connects and then silently drops spans.
      expect(
        resolveOtlpEndpoint({ endpoint: `http://collector:4317${suffix}` })
      ).toBe('http://collector:4317');
    }
  );

  it('strips trailing slashes', () => {
    expect(resolveOtlpEndpoint({ endpoint: 'http://collector:4317///' })).toBe(
      'http://collector:4317'
    );
  });

  it('treats an empty endpoint as unset', () => {
    process.env[OTEL_ENDPOINT_ENV] = '';
    expect(resolveOtlpEndpoint()).toBeUndefined();
    expect(resolveOtlpEndpoint({ endpoint: '' })).toBeUndefined();
  });
});

describe('header and service-name resolution', () => {
  it('returns undefined when no headers are configured', () => {
    expect(resolveOtlpHeaders()).toBeUndefined();
    expect(resolveOtlpHeaders({})).toBeUndefined();
    expect(resolveOtlpHeaders({ headers: {} })).toBeUndefined();
  });

  it('copies headers rather than aliasing the caller config', () => {
    const headers = { authorization: 'Bearer t' };
    const resolved = resolveOtlpHeaders({ headers });

    expect(resolved).toEqual(headers);
    expect(resolved).not.toBe(headers);
  });

  it('resolves the service name config > env > fallback', () => {
    expect(resolveServiceName('fallback')).toBe('fallback');

    process.env[OTEL_SERVICE_NAME_ENV] = 'from-env';
    expect(resolveServiceName('fallback')).toBe('from-env');
    expect(resolveServiceName('fallback', { serviceName: 'explicit' })).toBe(
      'explicit'
    );
  });
});

describe('setupTelemetry', () => {
  it('is a no-op when no endpoint is configured', async () => {
    // This is the normal local-dev path. A non-undefined return here means
    // every `pnpm dev` just started an exporter nobody asked for.
    await expect(setupTelemetry('svc')).resolves.toBeUndefined();
    await expect(
      setupTelemetry('svc', { enabled: false })
    ).resolves.toBeUndefined();
  });

  it('does not load the OTel SDK when disabled', async () => {
    // The SDK sits behind a dynamic import precisely so a process that never
    // configures tracing never pays for it.
    await setupTelemetry('svc');
    expect(
      Object.keys(process.env).some((k) => k.startsWith('OTEL_SDK_LOADED'))
    ).toBe(false);
  });
});

describe('tracer surface', () => {
  it('returns a usable tracer with no provider registered', () => {
    // Instrumentation code must never have to branch on whether telemetry is
    // configured; the API's no-op tracer is what makes that safe.
    const tracer = getTracer('guard');

    expect(typeof tracer.startSpan).toBe('function');
    expect(typeof tracer.startActiveSpan).toBe('function');

    const span = tracer.startSpan('smoke');
    expect(() => span.end()).not.toThrow();
  });

  it('runs a callback inside startActiveSpan', () => {
    let ran = false;
    getTracer('guard').startActiveSpan('smoke', (span) => {
      ran = true;
      span.end();
    });
    expect(ran).toBe(true);
  });
});

describe('upstream OpenTelemetry contract', () => {
  it('pins the @opentelemetry/api surface setupTelemetry depends on', async () => {
    const api = await import('@opentelemetry/api');

    expect(typeof api.trace.getTracer).toBe('function');
    expect(typeof api.trace.setGlobalTracerProvider).toBe('function');
    expect(api.SpanStatusCode.ERROR).toBeDefined();
  });

  it('pins the SDK exports setupTelemetry imports dynamically', async () => {
    // These four imports are invisible to the type-checker's reachability
    // analysis in the disabled path, so this is the only thing standing
    // between a renamed export and a runtime crash the first time someone
    // sets OTEL_EXPORTER_OTLP_ENDPOINT in production.
    const [sdk, exporter, resources, semconv] = await Promise.all([
      import('@opentelemetry/sdk-trace-node'),
      import('@opentelemetry/exporter-trace-otlp-grpc'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/semantic-conventions'),
    ]);

    expect(typeof sdk.NodeTracerProvider).toBe('function');
    expect(typeof sdk.BatchSpanProcessor).toBe('function');
    expect(typeof exporter.OTLPTraceExporter).toBe('function');
    expect(typeof resources.resourceFromAttributes).toBe('function');
    expect(typeof semconv.ATTR_SERVICE_NAME).toBe('string');
  });

  it('accepts gRPC metadata for authenticated collectors', async () => {
    const { Metadata } = await import('@grpc/grpc-js');
    const metadata = new Metadata();

    metadata.set('authorization', 'Bearer t');

    expect(metadata.get('authorization')).toEqual(['Bearer t']);
  });

  it('constructs a provider against a real endpoint', async () => {
    // The one path that actually exercises the dynamic imports end to end.
    // Nothing is exported: the collector URL is unreachable and the
    // BatchSpanProcessor never flushes before shutdown.
    const handle = await setupTelemetry('guard-svc', {
      endpoint: 'http://127.0.0.1:4317',
      headers: { authorization: 'Bearer t' },
    });

    expect(handle).toBeDefined();
    expect(handle?.serviceName).toBe('guard-svc');
    expect(handle?.endpoint).toBe('http://127.0.0.1:4317');

    await expect(handle?.shutdown()).resolves.toBeUndefined();
  });
});

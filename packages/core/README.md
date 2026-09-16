# @diagrid/agent-core

The shared Dapr Workflow runtime behind the Diagrid AI agent adapters.

Application code normally installs an adapter (e.g.
[`@diagrid/agent-mastra`](../mastra/README.md)) rather than this package
directly. Install it directly when you are **writing an adapter** — this is the
package whose two base classes you implement.

## What lives here

| Module          | Export                                    | Role                                                                                         |
| --------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `agent/`        | `agentWorkflow`, `invokeModelActivity`, … | **The durable agent loop** — orchestrator, activities and activity retry, framework-agnostic |
| `agent/`        | `agentWorkflowInputSchema`, …             | Zod schemas for everything crossing the workflow boundary                                    |
| `workflow/`     | `BaseWorkflowRunner`                      | Runtime lifecycle, canonical workflow naming, status/terminate/purge, graceful shutdown      |
| `workflow/`     | `buildWorkflowName`, `sanitizeAgentName`  | The cross-language naming contract (`dapr.<framework>.<AgentName>.workflow`)                 |
| `mapping/`      | `BaseAgentMapper`, `AgentMapper`          | **The framework extension point** — maps a native agent onto registry metadata               |
| `metadata/`     | `agentMetadataRecordSchema`, …            | Zod schemas for the agent registry record                                                    |
| `state/`        | `DaprStateStore`                          | JSON-serializing wrapper over a Dapr state store component                                   |
| `state/`        | `DaprAgentCheckpointer`                   | Conversation-memory checkpoints; key layout shared with `python-ai`, prefix per adapter      |
| `pubsub/`       | `DaprPubSub`                              | Publisher for agent lifecycle events                                                         |
| `telemetry/`    | `setupTelemetry`, `getTracer`             | OTLP/gRPC tracing — a **no-op** unless `OTEL_EXPORTER_OTLP_ENDPOINT` (or config) is set      |
| `identity/`     | `oauthMiddleware`, `oauthPlugin`, …       | **Verified inbound callers** — JWKS-backed JWT verification, Express and Fastify adapters    |
| `workflow/dapr` | Dapr workflow types                       | Type-only re-exports, so adapters never depend on `@dapr/dapr` themselves                    |

### Why the agent loop is here and not in an adapter

It began in the Mastra adapter, and a review made the consequence plain: none of
it mentions a framework. A message, a tool call, one model turn, the retry
policy and the checkpoint key layout are the same shapes whichever SDK produced
them — so adapter #2 would have copied the whole durable loop, including
invariants that are easy to get subtly wrong (the orchestrator must be an
`async function*`; the schema-parse must sit _outside_ the retry region; the
clock must come from `getCurrentUtcDateTime()`). Two copies drift, and the
drift is silent.

What is genuinely per-framework is small: driving the SDK one step at a time so
tool execution stays inside checkpointed activities, and reading a native agent
structurally for its metadata.

## Writing an adapter

Two things to implement:

<!-- typecheck: skip — a template for a future adapter, not runnable code:
     `MY_FRAMEWORK`, `myAgentWorkflow` and `myActivity` are placeholders the
     implementer replaces. Checked blocks live in the root and mastra READMEs. -->

```ts
import {
  BaseAgentMapper,
  BaseWorkflowRunner,
  SupportedFrameworks,
  type AgentMapper,
  type AgentMetadataRecord,
  type SupportedFramework,
  type WorkflowRuntime,
} from '@diagrid/agent-core';

class MyFrameworkMapper extends BaseAgentMapper {
  readonly framework: SupportedFramework = SupportedFrameworks.MY_FRAMEWORK;

  // Async by contract: frameworks commonly hide an agent's config behind async
  // accessors (Mastra's `Agent.listTools()` returns a Promise), and a sync
  // mapper would silently report empty tools for every real agent.
  async mapAgentMetadata(agent: unknown): Promise<AgentMetadataRecord> {
    // Read the framework-native agent, then hand the partial record to
    // `this.finalize(...)`, which fills defaults, derives the workflow name
    // and validates the result.
    return this.finalize({/* … */});
  }
}

class MyFrameworkRunner extends BaseWorkflowRunner {
  readonly #mapper = new MyFrameworkMapper();

  get mapper(): AgentMapper {
    return this.#mapper;
  }

  protected registerWorkflowComponents(runtime: WorkflowRuntime): void {
    runtime.registerWorkflowWithName(this.workflowName, myAgentWorkflow);
    runtime.registerActivityWithName('…', myActivity);
  }
}
```

Two rules the CI guards enforce:

- **Import the framework SDK as a peer, never a dependency.** Read native agents
  structurally so the framework stays out of the runtime graph. Read config
  through the framework's _accessors_ (`getInstructions()`, `listTools()`), not
  its plain properties — a real instance usually keeps those private, and a
  property-only mapper passes every fixture-based test while reporting nothing
  for real agents.
- **Import Dapr types from here, not from `@dapr/dapr`.** One package owns the
  SDK version; see `src/workflow/dapr.ts` for why.

Then add an `ADAPTERS` entry in
`tests/guards/cross-framework-imports.test.ts` — it fails until you do.

## Telemetry

`setupTelemetry()` returns `undefined` when no OTLP endpoint is configured, and
that is success, not an error — it is the normal local-dev path. `getTracer()`
is always safe to call: with no provider registered the OTel API hands back a
no-op tracer, so instrumentation never has to branch on whether tracing is on.

Resolution precedence for the endpoint is explicit config → then
`OTEL_EXPORTER_OTLP_ENDPOINT`, with `enabled: false` short-circuiting either.
Signal path suffixes (`/v1/traces`) are stripped, because the gRPC exporter wants
a bare `host:port`.

## Identity

Verified inbound callers and on-behalf-of outbound calls, mirroring
`diagrid.identity` in the Python SDK. One line of app code buys the inbound
half; the outbound half costs none.

```ts
import express from 'express';
import { getVerifiedUser, oauthMiddleware } from '@diagrid/agent-core/express';

const app = express();
app.use(oauthMiddleware({ scopes: ['agent.invoke'] }));

app.post('/invoke', (req, res) => {
  res.json({ caller: getVerifiedUser(req)?.subject });
});
```

Fastify, with the same options:

```ts
import Fastify from 'fastify';
import { getVerifiedUser, oauthPlugin } from '@diagrid/agent-core/fastify';

const app = Fastify();
await app.register(oauthPlugin, { scopes: ['agent.invoke'] });

app.post('/invoke', (request) => ({
  caller: getVerifiedUser(request)?.subject,
}));
```

**Express and Fastify are optional peers**, and each adapter is its own
subpath entry point: `@diagrid/agent-core/express` and
`@diagrid/agent-core/fastify`. Install whichever one you serve with;
installing neither is fine, and the package barrel resolves neither — not at
runtime and not at type-check time, where a barrel that re-exported them would
hand `TS2307` to anyone type-checking without `skipLibCheck`.
`tests/guards/cross-framework-imports.test.ts` holds that line.

The verified caller is read with `getVerifiedUser(req)` rather than from
`req.user`. `user` is the application's slot — Passport's, typically — and a
library that claimed it would overwrite the app's own user at runtime and
collide with `@types/passport`'s declaration of it at compile time. The Python
SDK makes the same distinction with `request.state.diagrid_user`.

Outbound on-behalf-of calls cost nothing beyond the `fetch` you build once.
`createIdentityFetch()` hands back an ordinary `fetch`-shaped function, so an
app makes an ordinary call and never assembles an identity header itself:

```ts
import { createIdentityFetch } from '@diagrid/agent-core';

// Once, at module scope. The token is read per call, not captured here.
const identityFetch = createIdentityFetch();

export async function search(query: string): Promise<Response> {
  return identityFetch('https://mcp.example.com/tools/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
}
```

A function rather than a client class because that is what the MCP SDK,
generated API clients and most HTTP libraries accept: pass `identityFetch`
wherever a custom `fetch` is taken and the calls underneath it carry the
caller.

Three properties are worth knowing, because they are the reasons not to
assemble the header by hand:

- **The token is read at call time.** One long-lived, shared `identityFetch` is
  safe: concurrent requests each carry their own caller's token. A header
  captured when the function was built would send whichever user happened to be
  current then.
- **The header is cleared before it is set.** A request never carries an
  identity the current context does not hold, whatever set it. Outside a
  verified request — a scheduled, pub/sub or cron trigger — the header is
  omitted entirely rather than sent empty, and the call proceeds
  unauthenticated rather than throwing.
- **The token goes only to the origin you addressed.** A redirect to another
  origin drops it; without that, a `Location` of the callee's choosing would
  hand the caller's token to whatever host it names. The one exception is a
  same-host upgrade from `http` on port 80 to `https` on port 443. Enforcing it
  means the chain is walked here rather than inside `fetch`, so a followed
  `Response` reports `redirected === false`.

Pass your own `fetch` as `createIdentityFetch({ fetch })` to keep a wrapper you
already have — tracing, retries, a test double — with identity layered over it.
For a client you cannot replace at all, `attachIdentityHeaders(request)` is the
same behaviour as a one-request interceptor; its own doc comment says what the
origin guard cannot cover from there.

Scopes are checked with `hasScope(user, scope)` — the free-function sibling of
`has_scope` in the Python SDK and `HasScope` in the Java and .NET ones. It is a
function rather than a method because `VerifiedUser` is a plain shape, so it
keeps working on one revived from a workflow payload, a cache, or a fixture:

```ts
import express from 'express';
import { hasScope } from '@diagrid/agent-core';
import { getVerifiedUser } from '@diagrid/agent-core/express';

const app = express();

app.post('/admin', (req, res) => {
  const user = getVerifiedUser(req);
  if (!user || !hasScope(user, 'agent.admin')) {
    res.status(403).json({ error: 'oauth.missing_scope' });
    return;
  }
  res.json({ ok: true });
});
```

Verification coordinates are discovered, in order: explicit `issuer` +
`jwksUri` → the local sidecar's `/v1.0/metadata` (`DAPR_HTTP_PORT`) → a remote
sidecar's `/v1.0/metadata` (`DAPR_HTTP_ENDPOINT`, which is how `diagrid dev
run` reaches a Catalyst-hosted sidecar with nothing on loopback) →
`DIAGRID_DP_SENTRY_ISSUER`. Local comes before remote so a deployed in-cluster
app keeps answering from the loopback call. A single explicit field narrows
whichever source answers rather than replacing it, so pinning only an
`audience` still lets discovery find the issuer — and pinning only an `issuer`
is enough on its own, since the JWKS URI is then derived as `issuer` +
`/jwks.json`. A `jwks_uri` a sidecar advertises is adopted over that derived
value, but only when the issuer it advertised is the issuer that was actually
resolved: a pinned issuer must never be verified against a foreign issuer's key
set. When `DAPR_API_TOKEN` is set the
remote probe carries it as `dapr-api-token`; over a non-`https` endpoint it is
still sent, with a warning that it travels in the clear.

It fails closed throughout — 401 for a caller's bad or missing token, 403 for a
missing scope, 503 when key material or configuration is the server's problem.
Every refusal answers `{"error":"<code>"}` under `Cache-Control: no-store`,
with a code identical to every other Diagrid SDK's. The ten of them, in the
order `OAuthErrorCodes` declares them:

| Status | Code                         | When                                                                                                |
| ------ | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| 401    | `oauth.missing_token`        | No `X-Diagrid-User-Token` on a request that required one.                                           |
| 503    | `oauth.not_configured`       | No verifier could be built: no source supplied an issuer, or the JWKS URI is unusable.              |
| 503    | `oauth.verifier_unavailable` | The key set could not be fetched, or held no key matching the token.                                |
| 401    | `oauth.expired`              | `exp` is in the past, beyond the 120s clock skew.                                                   |
| 401    | `oauth.invalid_issuer`       | `iss` does not match the resolved issuer.                                                           |
| 401    | `oauth.invalid_audience`     | `aud` does not match the resolved audience.                                                         |
| 401    | `oauth.invalid_signature`    | The signature does not verify against the JWKS key.                                                 |
| 401    | `oauth.decode_error`         | The token is not a well-formed JWS at all.                                                          |
| 401    | `oauth.invalid_token`        | Any other claim or algorithm failure — a missing `exp`/`iss`/`sub`, an `alg` outside the allowlist. |
| 403    | `oauth.missing_scope`        | The token verified but did not carry every scope `scopes` asked for.                                |

`VerifiedUser.scopes` is ordinally sorted and carries no duplicates, whichever
of `scp` / `scope` / `scopes` the token used and in whatever order it listed
them. Scopes are a set: the order a token happens to list them in is not a
grant, and every Diagrid SDK reports the same order for the same token — which
matters, because echoing `user.scopes` into a JSON body is the commonest thing
a handler does with them.

`requireAuth` governs the no-token case and nothing else. Left at its default
of `true`, a request with no `X-Diagrid-User-Token` is refused 401
`oauth.missing_token`; set to `false`, that request passes through with no
verified caller attached. A token that **is** present is always verified either
way, and an invalid one is always refused.

However the JWKS URI is resolved, it must be `https`. Plaintext is refused with
503 `oauth.not_configured`, because the key set is the entire root of trust: an
on-path attacker who rewrites an `http` response substitutes his own keys and
every signature check afterwards confirms his signature. A loopback host is
exempt — that is where the local sidecar publishes its keys, and the host is
parsed rather than pattern-matched, so a DNS name like `127.evil.example` is
not one. `allowInsecureJwks: true` opts out anywhere else, and it relaxes plain
`http` **only**: opting into plaintext says nothing about reading signing keys
off a filesystem, so a `file://` URI stays refused with the flag set. A JWKS
URI that will not parse at all is refused the same way, at build time rather
than on every request — it is a configuration error, not a downgrade.

## License

[Business Source License 1.1](../../LICENSE.md) — © 2026–Present Diagrid Inc.

# Identity example

A two-route Express service that verifies inbound Catalyst user tokens with
[`@diagrid/agent-core`](../../packages/core/README.md) and carries the verified
caller onto an outbound call. Deliberately minimal — no agent, no model, no
workflow, no state store, so the identity surface is the only thing on screen.

## How it works

The install is three lines of app code in [`service.ts`](service.ts) — two
inbound, one outbound:

```ts
import express from 'express';
import { createIdentityFetch } from '@diagrid/agent-core';
import type { OAuthConfig } from '@diagrid/agent-core';
import { oauthMiddleware } from '@diagrid/agent-core/express';

const app = express();

const config: OAuthConfig = {};
app.use(oauthMiddleware(config));

const identityFetch = createIdentityFetch();
```

Everything is left at its default: `requireAuth` is true, so both routes are
closed until a token verifies; no scopes are required on the middleware; and no
issuer, audience or JWKS URI is set, so the verifier discovers its coordinates
from the sidecar's `/v1.0/metadata`.

Those three lines plus two handlers demonstrate three things:

- **Inbound verification** — the middleware verifies `X-Diagrid-User-Token`
  against dp-Sentry's JWKS and answers `401` itself when it cannot.
- **Reading the caller** — `GET /whoami` reads the caller through
  `getVerifiedUser(req)`, the typed accessor, and returns their `subject`,
  `tenant` and `scopes`, plus `hasRead` from `hasScope(user, 'read')`. No cast
  out of a string-keyed bag.
- **Outbound propagation** — `GET /downstream` makes one ordinary
  `identityFetch(DOWNSTREAM_URL)`, and the callee sees the same caller. The
  handler names no header: `createIdentityFetch()` returns a `fetch`-shaped
  function that reads the caller's token when the call is made, clears the
  header before setting it, and drops it if a redirect leaves the origin the
  call addressed. It returns `{"downstream": "<the raw body>"}`, or `502`
  `{"error":"downstream_unreachable"}` when the call fails. That code is this
  example's own — every other code on the wire is an SDK one.

## Run it

```bash
pnpm install                                   # from the repo root
diagrid dev run --app-id identity -- pnpm start
```

`diagrid dev run` attaches the Catalyst sidecar the verifier discovers its
issuer, audience and JWKS URI from.

Without a sidecar — `pnpm start` on its own, or a plain `dapr run`, whose OSS
sidecar publishes no `identity` block — there are no coordinates to discover,
and the two failures look different on purpose. A request carrying a token
answers `503` `{"error":"oauth.not_configured"}`, because the server cannot
check it; a request carrying none still answers `401`
`{"error":"oauth.missing_token"}`, because the missing header is decided before
any verifier is needed. A warning naming the endpoint that could not be reached
goes to `stderr` either way.

To see `/downstream` propagate, start a second copy to call:

```bash
PORT=8081 diagrid dev run --app-id identity-downstream -- pnpm start
```

`PORT` defaults to `8080` and `DOWNSTREAM_URL` to `http://localhost:8081/whoami`.

## Try it

With a valid token:

```bash
curl -s localhost:8080/whoami -H "X-Diagrid-User-Token: Bearer $TOKEN"
{"subject":"alice@example.com","tenant":"acme","scopes":["read","write"],"hasRead":true}

curl -s localhost:8080/downstream -H "X-Diagrid-User-Token: Bearer $TOKEN"
{"downstream":"{\"subject\":\"alice@example.com\",\"tenant\":\"acme\",\"scopes\":[\"read\",\"write\"],\"hasRead\":true}"}
```

Every refusal has the same body shape — `{"error":"<code>"}`, where the code is
one of the `OAuthErrorCodes` values:

```bash
# No token at all
curl -s -o /dev/stderr -w '%{http_code}\n' localhost:8080/whoami
{"error":"oauth.missing_token"}
401

# Garbage in the header
curl -s -o /dev/stderr -w '%{http_code}\n' localhost:8080/whoami \
  -H 'X-Diagrid-User-Token: Bearer not-a-jwt'
{"error":"oauth.decode_error"}
401

# A well-formed token whose exp has passed
curl -s -o /dev/stderr -w '%{http_code}\n' localhost:8080/whoami \
  -H "X-Diagrid-User-Token: Bearer $EXPIRED_TOKEN"
{"error":"oauth.expired"}
401
```

## Notes

- **The token comes from the sidecar.** Catalyst sets `X-Diagrid-User-Token` on
  requests it forwards to your app; the middleware reads that header and nothing
  else. An `Authorization` header is deliberately ignored — it belongs to
  whatever your own front door uses.
- **`identityFetch` is built once, at module scope.** It is shared by every
  request on purpose: the token is read when a call is made, so two requests in
  flight at once each carry their own caller. Built per request it would work
  too, and buy nothing. A call with no inbound caller at all — a scheduled,
  pub/sub or cron trigger — is not an error: the header is omitted and the call
  goes out unauthenticated.
- **`requireAuth: false` opens a route up.** Health and readiness endpoints that
  have to answer before a caller exists want a second app, or a mount path, with
  `requireAuth` off. `getVerifiedUser` then returns `undefined`, which is why it
  is typed that way.
- **`allowInsecureJwks: true` is for local development only.** A plaintext JWKS
  URI is refused by default, and a loopback host is already exempt without the
  flag. Setting it anywhere else lets an on-path attacker substitute his own key
  set, after which every signature this app checks confirms his signature rather
  than dp-Sentry's. Never set it in production.

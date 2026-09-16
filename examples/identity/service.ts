// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Example: verified callers, end to end.
 *
 * A two-route HTTP service that does the three things any app behind Catalyst
 * has to do with an identity: verify the inbound user token, read the caller
 * off the request, and carry that caller onto an outbound call.
 *
 * Deliberately minimal — no agent, no model, no workflow, no state store. The
 * other examples in this repo show durable agent turns; this one shows the
 * identity surface alone, so nothing else has to be running for it to work.
 *
 *     pnpm start
 *
 * See ./README.md for the curl commands and the failures to expect.
 */

import express from 'express';
import type { Request, Response } from 'express';

import { createIdentityFetch, hasScope } from '@diagrid/agent-core';
import type { OAuthConfig, VerifiedUser } from '@diagrid/agent-core';
import { getVerifiedUser, oauthMiddleware } from '@diagrid/agent-core/express';

const PORT = Number(process.env['PORT'] ?? 8080);

/** Where `/downstream` calls. Point it at a second copy of this service. */
const DOWNSTREAM_URL =
  process.env['DOWNSTREAM_URL'] ?? 'http://localhost:8081/whoami';

/** The scope `/whoami` reports on, to show `hasScope` against the typed caller. */
const DEMO_SCOPE = 'read';

/**
 * The one error code this example invents.
 *
 * The `oauth.*` vocabulary belongs to the middleware; a downstream that will
 * not answer is this service's own problem to name.
 */
const DOWNSTREAM_UNREACHABLE = 'downstream_unreachable';

const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;

/**
 * The outbound half of the identity surface: one `fetch`, built once.
 *
 * Module scope on purpose. The caller's token is read when a call is made, not
 * when this is built, so one shared function serves every request and each
 * outbound call carries the caller who reached this service.
 */
const identityFetch = createIdentityFetch();

const app = express();

// Everything left at its default: no required scopes, so `/whoami` asks about
// one with `hasScope` instead and the example runs without any scope setup; no
// issuer, audience or JWKS URI, so the verifier discovers its coordinates from
// the sidecar's `/v1.0/metadata`; and `requireAuth` defaulting to true, so both
// routes below are closed until a token verifies.
const config: OAuthConfig = {};
app.use(oauthMiddleware(config));

/**
 * The verified caller, or `undefined` once the request has been answered.
 *
 * `getVerifiedUser` is honestly typed `VerifiedUser | undefined`, because a
 * route that `requireAuth: false` opened up has no caller to report. This
 * service leaves `requireAuth` at its default, so the guard is written out
 * rather than cast away.
 *
 * It answers 500 with no body deliberately: reaching it would mean a bug in
 * this service's wiring, and answering `oauth.missing_token` would put a code
 * on the wire the middleware did not produce.
 */
function requireUser(req: Request, res: Response): VerifiedUser | undefined {
  const user = getVerifiedUser(req);
  if (!user) {
    res.status(HTTP_INTERNAL_SERVER_ERROR).end();
  }
  return user;
}

/** Report the verified caller the middleware attached to this request. */
app.get('/whoami', (req, res) => {
  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  res.json({
    subject: user.subject,
    tenant: user.tenant,
    scopes: user.scopes,
    hasRead: hasScope(user, DEMO_SCOPE),
  });
});

/** Call a second service on behalf of the caller who reached this one. */
app.get('/downstream', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  try {
    // `identityFetch` reads back the token the middleware scoped to this
    // request, so the callee verifies the same caller this service did — no
    // headers named here, and none to forget to clear.
    const response = await identityFetch(DOWNSTREAM_URL);
    res.json({ downstream: await response.text() });
  } catch {
    res.status(HTTP_BAD_GATEWAY).json({ error: DOWNSTREAM_UNREACHABLE });
  }
});

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log('  GET /whoami      the verified caller');
  console.log(`  GET /downstream  on-behalf-of call to ${DOWNSTREAM_URL}`);
});

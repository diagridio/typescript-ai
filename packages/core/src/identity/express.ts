// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Express middleware for inbound user-token verification.
 *
 * `./fastify.ts` is the other adapter, and both defer to `./authenticate.ts`
 * for every decision so the two cannot answer the same request differently.
 *
 * Express is an **optional** peer dependency, and this file is why it can be:
 * it imports nothing from `express` but types, which `verbatimModuleSyntax`
 * erases before the bundle is written.
 *
 * It is also its own entry point — `@diagrid/agent-core/express`, not the
 * package barrel — because the declarations cannot erase `RequestHandler`. A
 * barrel that re-exported this module would put
 * `import { RequestHandler } from 'express'` at the top of `dist/index.d.ts`
 * and hand `TS2307` to every consumer without Express who type-checks on a
 * default `tsconfig`, where `skipLibCheck` is `false`.
 *
 * ```ts
 * import express from 'express';
 * import { getVerifiedUser, oauthMiddleware } from '@diagrid/agent-core/express';
 *
 * const app = express();
 * app.use(oauthMiddleware({ scopes: ['agent.invoke'] }));
 *
 * app.post('/invoke', (req, res) => {
 *   res.json({ caller: getVerifiedUser(req)?.subject });
 * });
 * ```
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import {
  CACHE_CONTROL_HEADER,
  CACHE_CONTROL_NO_STORE,
  authenticate,
} from './authenticate';
import { USER_TOKEN_HEADER, runWithUserToken } from './outbound';
import type { OAuthConfig, VerifiedUser } from './types';
import { lazyVerifier } from './verifier';
import type { TokenVerifier } from './verifier';

/**
 * The slot `oauthMiddleware` attaches the verified caller to.
 *
 * Deliberately *not* `req.user`, and deliberately not a `declare global`
 * augmentation of the `Express` namespace. `user` belongs to the application:
 * `@types/passport` declares it as `Express.User`, so a second global
 * declaration of it is a hard `TS2717` for every consumer that has both
 * installed — and at runtime the middleware would silently overwrite whatever
 * the app's own front door had already put there.
 *
 * No augmentation is published at all: {@link getVerifiedUser} is the
 * accessor, which keeps the name off every consumer's `Request` type whether
 * or not they import this module.
 */
interface WithVerifiedUser {
  /**
   * The verified caller, set by `oauthMiddleware`.
   *
   * Optional because a route reachable with `requireAuth: false` has no
   * verified caller, and neither has a handler mounted ahead of the middleware.
   */
  diagridUser?: VerifiedUser;
}

/**
 * The verified caller for this request, or `undefined`.
 *
 * `undefined` on a route that {@link OAuthConfig.requireAuth} `false` let
 * through unauthenticated, and on any handler mounted ahead of
 * {@link oauthMiddleware}.
 */
export function getVerifiedUser(req: Request): VerifiedUser | undefined {
  return (req as Request & WithVerifiedUser).diagridUser;
}

export interface OAuthMiddlewareOptions extends OAuthConfig {
  /**
   * Pre-built verifier. Injected by tests; production leaves it unset so the
   * middleware discovers its coordinates on the first authenticated request.
   */
  readonly verifier?: TokenVerifier;
}

/**
 * Verify `X-Diagrid-User-Token` on every inbound request.
 *
 * Reads only that header — an `Authorization` header is deliberately ignored,
 * because it belongs to whatever the app's own front door uses and must not
 * be mistaken for a dp-Sentry user token.
 */
export function oauthMiddleware(
  options: OAuthMiddlewareOptions = {}
): RequestHandler {
  const { verifier, ...config } = options;
  const getVerifier = lazyVerifier(config, verifier);

  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const outcome = await authenticate(
      req.get(USER_TOKEN_HEADER),
      config,
      getVerifier
    );

    switch (outcome.kind) {
      case 'rejected':
        res
          .status(outcome.status)
          .set(CACHE_CONTROL_HEADER, CACHE_CONTROL_NO_STORE)
          .json({ error: outcome.code });
        return;

      case 'anonymous':
        next();
        return;

      case 'authenticated':
        (req as Request & WithVerifiedUser).diagridUser = outcome.user;
        // `next()` is called inside the token scope rather than before it, so
        // every downstream handler — and everything it awaits — can read the
        // token back for an on-behalf-of call. The scope ends with the
        // request; there is no token left behind to clear.
        runWithUserToken(outcome.token, next);
    }
  };
}

// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Fastify plugin for inbound user-token verification.
 *
 * `./express.ts` is the other adapter, and both defer to `./authenticate.ts`
 * for every decision.
 *
 * Fastify is an **optional** peer dependency: the only value imported here is
 * `fastify-plugin`, a two-kilobyte, zero-dependency marker that does not pull
 * Fastify in. Everything from `fastify` itself is a type, erased before the
 * bundle is written.
 *
 * It is also its own entry point — `@diagrid/agent-core/fastify`, not the
 * package barrel — for the reason spelled out in `./express.ts`: the
 * declarations cannot erase `FastifyPluginCallback`. Keeping this module off
 * the barrel also keeps `fastify-plugin` off `dist/index.js`, so an app serving
 * over Express, or over no HTTP at all, never loads it.
 *
 * ```ts
 * import Fastify from 'fastify';
 * import { getVerifiedUser, oauthPlugin } from '@diagrid/agent-core/fastify';
 *
 * const app = Fastify();
 * await app.register(oauthPlugin, { scopes: ['agent.invoke'] });
 *
 * app.post('/invoke', (request) => ({
 *   caller: getVerifiedUser(request)?.subject,
 * }));
 * ```
 */

import fp from 'fastify-plugin';
import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';

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
 * The slot `oauthPlugin` decorates, and the name it is read back under.
 *
 * Deliberately not `request.user`: that name belongs to the application, and
 * `@fastify/passport` decorates it. Fastify refuses a second decorator under
 * the same name outright (`FST_ERR_DEC_ALREADY_PRESENT`), so claiming it does
 * not merely shadow the app's own auth — it stops the app from registering
 * its own.
 *
 * The augmentation is scoped to the `fastify` module rather than declared
 * globally, so it reaches only consumers who have Fastify — and, since this
 * file is its own entry point, only those who import it.
 */
declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The verified caller, set by `oauthPlugin`.
     *
     * Optional because a route reachable with `requireAuth: false` has no
     * verified caller. Prefer {@link getVerifiedUser} over reading it
     * directly, so the property name stays this module's business.
     */
    diagridUser?: VerifiedUser;
  }
}

/**
 * The verified caller for this request, or `undefined`.
 *
 * `undefined` on a route that {@link OAuthConfig.requireAuth} `false` let
 * through unauthenticated.
 */
export function getVerifiedUser(
  request: FastifyRequest
): VerifiedUser | undefined {
  return request.diagridUser;
}

/** Node lower-cases incoming header names, and Fastify does not re-case them. */
const USER_TOKEN_HEADER_KEY = USER_TOKEN_HEADER.toLowerCase();

/** Named, so Fastify reports a double `register` rather than installing the hook twice. */
const PLUGIN_NAME = '@diagrid/agent-core/identity';

/** Fastify majors this plugin has been verified against. */
const SUPPORTED_FASTIFY = '5.x';

export interface OAuthPluginOptions extends OAuthConfig {
  /**
   * Pre-built verifier. Injected by tests; production leaves it unset so the
   * plugin discovers its coordinates on the first authenticated request.
   */
  readonly verifier?: TokenVerifier;
}

const plugin: FastifyPluginCallback<OAuthPluginOptions> = (
  app,
  options,
  done
) => {
  const { verifier, ...config } = options;
  const getVerifier = lazyVerifier(config, verifier);

  app.decorateRequest('diagridUser', undefined);

  app.addHook(
    'onRequest',
    (
      request: FastifyRequest,
      reply: FastifyReply,
      next: HookHandlerDoneFunction
    ) => {
      const raw = request.headers[USER_TOKEN_HEADER_KEY];

      // The callback form of the hook, not the async one, and deliberately:
      // an async hook resolves *before* Fastify runs the handler, so a token
      // scope entered inside it would already have closed. Calling `next()`
      // from within the scope is what keeps the token readable for the rest
      // of the request.
      void authenticate(
        Array.isArray(raw) ? raw[0] : raw,
        config,
        getVerifier
      ).then(
        (outcome) => {
          switch (outcome.kind) {
            case 'rejected':
              // Replying from a hook ends the lifecycle; `next()` must not
              // also be called, or Fastify runs the handler for a request
              // already answered.
              void reply
                .code(outcome.status)
                .header(CACHE_CONTROL_HEADER, CACHE_CONTROL_NO_STORE)
                .send({ error: outcome.code });
              return;

            case 'anonymous':
              next();
              return;

            case 'authenticated':
              request.diagridUser = outcome.user;
              runWithUserToken(outcome.token, next);
          }
        },
        // Passed as `then`'s second argument rather than chained with
        // `.catch`, so a throw from inside the success path above cannot
        // reach it and call `next` a second time.
        (error: unknown) => {
          next(error instanceof Error ? error : new Error(String(error)));
        }
      );
    }
  );

  done();
};

/**
 * Verify `X-Diagrid-User-Token` on every inbound request.
 *
 * Wrapped with `fastify-plugin` so the `onRequest` hook and the `diagridUser`
 * decorator apply to the whole app rather than to an encapsulated child
 * context, where no route outside the plugin would be protected.
 *
 * Reads only that header — an `Authorization` header is deliberately ignored,
 * because it belongs to whatever the app's own front door uses and must not
 * be mistaken for a dp-Sentry user token.
 */
export const oauthPlugin = fp(plugin, {
  fastify: SUPPORTED_FASTIFY,
  name: PLUGIN_NAME,
});

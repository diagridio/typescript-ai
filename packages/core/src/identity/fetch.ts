// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Identity-aware `fetch` for outbound on-behalf-of calls.
 *
 * A `fetch`-shaped function rather than a client object, because the MCP SDK,
 * generated API clients and most HTTP libraries take a custom `fetch`.
 *
 * The sidecar mints an OBO token for whoever it identifies on the *inbound*
 * request. An outbound call to the MCP proxy or a sub-agent is a separate,
 * stateless request, so the caller's token has to ride on it explicitly:
 *
 * ```ts
 * import { createIdentityFetch } from '@diagrid/agent-core';
 *
 * const identityFetch = createIdentityFetch();
 *
 * export async function search(query: string): Promise<Response> {
 *   return identityFetch('https://mcp.example.com/tools/search', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ query }),
 *   });
 * }
 * ```
 *
 * The header is read from the `AsyncLocalStorage` at *call* time rather than
 * baked in at construction. That is what makes one long-lived, module-scope
 * `identityFetch` safe: concurrent requests each carry their own caller's
 * token, where a captured header would send whichever user was current when
 * the function was built.
 *
 * The token only ever goes to the origin the caller addressed; a redirect away
 * from it drops the header. Past that this is as wide as you make it, so call
 * third-party APIs with the plain global `fetch` instead. Note that
 * `X-Diagrid-User-Token` is not a header name log scrubbers and tracing SDKs
 * redact by default.
 *
 * The redirect chain is walked here rather than by `fetch`, which follows hops
 * internally and below any wrapper — so a wrapper alone cannot re-decide the
 * header per hop, and the one the first hop carried would ride to wherever the
 * callee's `Location` pointed. Three consequences: a caller-supplied `redirect`
 * of `'manual'` or `'error'` is passed straight through and nothing is
 * followed; the returned `Response` reports `redirected === false` even when
 * hops were followed, because a `Response` cannot be relabelled; and a request
 * body is buffered into memory up front, since a 307 or 308 has to resend it.
 *
 * {@link attachIdentityHeaders} is the interceptor for an app that owns a
 * `fetch` it cannot replace. It gets no origin guard, because a `Request` on
 * its own carries nothing to measure a later hop against, and it warns once
 * per process when it is handed a request that will follow redirects.
 */

import { debuglog } from 'node:util';

import { USER_TOKEN_HEADER, outboundIdentityHeaders } from './outbound';

/**
 * `NODE_DEBUG=diagrid:identity` turns the withheld-identity traces on.
 *
 * A call with no inbound caller is normal — scheduled, pub/sub and cron
 * triggers have none — so it is a debug trace, never a throw.
 */
const debug = debuglog('diagrid:identity');

/** Dispatch mode for every hop: the chain is walked here, not by `fetch`. */
const MANUAL_REDIRECT = 'manual' as const;

/** The redirect mode under which an interceptor cannot guard the origin. */
const FOLLOW_REDIRECT = 'follow' as const;

/** Name and code the interceptor's unguarded-redirect warning carries. */
const REDIRECT_UNGUARDED_WARNING = {
  type: 'DiagridIdentityRedirectUnguarded',
  code: 'DIAGRID_IDENTITY_REDIRECT_UNGUARDED',
} as const;

/** Said out loud the first time the interceptor is handed a followed request. */
const REDIRECT_UNGUARDED_MESSAGE =
  `attachIdentityHeaders was given a request with redirect: '${FOLLOW_REDIRECT}'. ` +
  'Whatever performs it follows redirects below this point, so the identity ' +
  `header can ride to a redirect target of the callee's choosing. Use ` +
  `createIdentityFetch(), which re-decides the header on every hop, or ` +
  `dispatch with redirect: '${MANUAL_REDIRECT}' or 'error' and follow the ` +
  'chain yourself. Warned once per process.';

/**
 * Whether the warning above has been emitted.
 *
 * Once per process rather than once per call: this sits on the outbound hot
 * path, where a line per request is noise an operator filters out.
 */
let warnedRedirectUnguarded = false;

/** The default `fetch` follows at most twenty hops; match it. */
const DEFAULT_MAX_REDIRECTS = 20;

const HTTP_SCHEME = 'http:';
const HTTPS_SCHEME = 'https:';
const HTTP_DEFAULT_PORT = '80';
const HTTPS_DEFAULT_PORT = '443';

const LOCATION_HEADER = 'location';

const STATUS_MOVED_PERMANENTLY = 301;
const STATUS_FOUND = 302;
const STATUS_SEE_OTHER = 303;
const STATUS_TEMPORARY_REDIRECT = 307;
const STATUS_PERMANENT_REDIRECT = 308;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  STATUS_MOVED_PERMANENTLY,
  STATUS_FOUND,
  STATUS_SEE_OTHER,
  STATUS_TEMPORARY_REDIRECT,
  STATUS_PERMANENT_REDIRECT,
]);

const METHOD_GET = 'GET';
const METHOD_HEAD = 'HEAD';
const METHOD_POST = 'POST';

/**
 * Headers the fetch specification itself drops on a cross-origin redirect.
 *
 * The built-in follower strips these, so a chain walked by hand inherits the
 * duty.
 */
const CROSS_ORIGIN_STRIPPED_HEADERS = [
  'authorization',
  'cookie',
  'proxy-authorization',
] as const;

/** Headers that describe a body, and so must go when the body does. */
const BODY_HEADERS = [
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-type',
] as const;

/** Options for {@link createIdentityFetch}. */
export interface IdentityFetchInit {
  /**
   * The `fetch` to dispatch through. Defaults to the global one.
   *
   * An app that already wraps `fetch` — for tracing, retries, a mock in
   * tests — passes its own here and keeps it. The identity header is applied
   * last, so it wins over anything that set the same header.
   */
  readonly fetch?: typeof globalThis.fetch;

  /** Redirect hops to follow before giving up. Defaults to 20, as `fetch` does. */
  readonly maxRedirects?: number;
}

/**
 * Set the caller's identity headers on `request`, in place.
 *
 * The interceptor on its own, for an app that already owns a `fetch` it cannot
 * replace:
 *
 * ```ts
 * import { attachIdentityHeaders } from '@diagrid/agent-core';
 *
 * const tracedFetch: typeof globalThis.fetch = (input, init) => {
 *   const request = new Request(input, init);
 *   attachIdentityHeaders(request);
 *   return globalThis.fetch(request);
 * };
 * ```
 *
 * The header is cleared first, so a request never carries an identity the
 * current context does not hold, whatever set it. Outside an inbound request
 * the header is omitted rather than sent empty.
 *
 * Used this way there is **no origin guard at all**: whatever performs the
 * request follows redirects below this point, so the header can ride to a
 * redirect target of the callee's choosing, and a `Request` on its own carries
 * nothing to compare a later hop against. Dispatch with `redirect: 'manual'` or
 * `'error'`, or use {@link createIdentityFetch}, which walks the chain and
 * re-decides the header on every hop. The limitation is also warned about once
 * per process, because a doc comment is not read by the app that is already
 * leaking.
 */
export function attachIdentityHeaders(request: Request): void {
  if (request.redirect === FOLLOW_REDIRECT && !warnedRedirectUnguarded) {
    warnedRedirectUnguarded = true;
    process.emitWarning(REDIRECT_UNGUARDED_MESSAGE, REDIRECT_UNGUARDED_WARNING);
  }

  setIdentity(request);
}

/**
 * A `fetch` that carries the calling user's identity.
 *
 * Takes the same two arguments the global `fetch` takes and returns the
 * callee's `Response`. Build one per process, at module scope; the token is
 * read per call.
 *
 * See this module's own doc comment for what the manual redirect walk changes.
 */
export function createIdentityFetch(
  init: IdentityFetchInit = {}
): typeof globalThis.fetch {
  const dispatch = init.fetch ?? globalThis.fetch;
  const maxRedirects = init.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  return async function identityFetch(input, requestInit) {
    // Normalising through `Request` copies the caller's headers rather than
    // writing through them.
    const request = new Request(input, requestInit);

    if (request.redirect !== FOLLOW_REDIRECT) {
      // The caller asked to see the 3xx themselves, or to fail on it: nothing
      // to follow, so nothing to guard and nothing to warn about — which is why
      // this sets the header directly rather than via the interceptor.
      setIdentity(request);
      return dispatch(request);
    }

    return followChain(request, dispatch, maxRedirects);
  };
}

/**
 * Dispatch `request`, walking its redirect chain by hand.
 *
 * Every hop is a fresh dispatch with `redirect: 'manual'`, so the identity
 * decision is made again against the origin the caller originally addressed.
 */
async function followChain(
  request: Request,
  dispatch: typeof globalThis.fetch,
  maxRedirects: number
): Promise<Response> {
  const originalUrl = new URL(request.url);
  const headers = new Headers(request.headers);
  // Buffered once, up front: a 307 or 308 has to resend the body, and a
  // `Request` body is a one-shot stream. The cost is that a streaming upload
  // is held in memory for the length of the call.
  const body = request.body === null ? null : await request.arrayBuffer();

  let hop: { url: URL; method: string; body: ArrayBuffer | null } = {
    url: originalUrl,
    method: request.method,
    body,
  };

  for (let followed = 0; ; followed += 1) {
    const hopRequest = buildHop(
      request,
      hop.url,
      hop.method,
      headers,
      hop.body
    );
    applyIdentity(hopRequest, originalUrl);

    const response = await dispatch(hopRequest);
    const location = response.headers.get(LOCATION_HEADER);
    if (!REDIRECT_STATUSES.has(response.status) || location === null) {
      return response;
    }

    if (followed >= maxRedirects) {
      // What `fetch` itself throws once its own hop budget is spent.
      throw new TypeError(
        `fetch failed: redirect count exceeded (${String(maxRedirects)})`
      );
    }

    const nextUrl = new URL(location, hop.url);
    if (nextUrl.origin !== hop.url.origin) {
      for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) {
        headers.delete(name);
      }
    }

    const nextMethod = methodAfterRedirect(response.status, hop.method);
    if (nextMethod !== hop.method) {
      for (const name of BODY_HEADERS) {
        headers.delete(name);
      }
    }

    hop = {
      url: nextUrl,
      method: nextMethod,
      body: nextMethod === hop.method ? hop.body : null,
    };
  }
}

/**
 * The method the next hop uses.
 *
 * The rules the built-in follower applies: a 303 rewrites anything but a
 * `HEAD` to a bodyless `GET`, and a 301 or 302 does the same to a `POST`. A
 * 307 or 308 preserves both method and body, which is why the body is
 * buffered.
 */
function methodAfterRedirect(status: number, method: string): string {
  if (status === STATUS_SEE_OTHER) {
    return method === METHOD_HEAD ? METHOD_HEAD : METHOD_GET;
  }
  if (
    (status === STATUS_MOVED_PERMANENTLY || status === STATUS_FOUND) &&
    method === METHOD_POST
  ) {
    return METHOD_GET;
  }
  return method;
}

/**
 * One hop's `Request`, dispatched in `manual` mode.
 *
 * `mode`, `credentials`, `cache` and `referrer` are left at their defaults
 * deliberately: Node's `fetch` does not act on them.
 */
function buildHop(
  base: Request,
  url: URL,
  method: string,
  headers: Headers,
  body: ArrayBuffer | null
): Request {
  const init: RequestInit = {
    method,
    headers,
    redirect: MANUAL_REDIRECT,
    signal: base.signal,
    integrity: base.integrity,
    keepalive: base.keepalive,
  };

  // A `GET` or `HEAD` carrying a body is a `TypeError` from the constructor.
  const bodyless =
    body === null || method === METHOD_GET || method === METHOD_HEAD;
  return bodyless
    ? new Request(url, init)
    : new Request(url, { ...init, body });
}

/**
 * Clear the identity header on `request`, then set it if this origin may have it.
 *
 * The origin half of the decision, which only the chain walk can make: it is
 * the request originally addressed that a hop is measured against, and only
 * {@link followChain} still holds it.
 */
function applyIdentity(request: Request, originalUrl: URL): void {
  if (!isOriginAllowed(originalUrl, new URL(request.url))) {
    // Cleared even so: an earlier hop of this same chain may have set it.
    request.headers.delete(USER_TOKEN_HEADER);
    debug('identity withheld: %s is not the origin called', request.url);
    return;
  }

  setIdentity(request);
}

/**
 * Clear the identity header on `request`, then set it from the current context.
 *
 * The clear is unconditional and comes first: whatever set the header before —
 * the caller, or an earlier hop of the same chain — the request must never
 * carry an identity the current context does not hold.
 */
function setIdentity(request: Request): void {
  request.headers.delete(USER_TOKEN_HEADER);

  const headers = outboundIdentityHeaders();
  const entries = Object.entries(headers);
  if (entries.length === 0) {
    debug('no inbound user context; calling %s unauthenticated', request.url);
    return;
  }

  for (const [name, value] of entries) {
    request.headers.set(name, value);
  }
}

/**
 * Whether `current` still addresses the origin the caller asked for.
 *
 * Without this a redirect from the MCP proxy would hand the caller's OBO token
 * to whatever host the `Location` names, since the built-in follower strips only
 * `Authorization` when a hop leaves the origin, never a custom header. The one
 * permitted change of origin is a same-host upgrade from HTTP on port 80 to
 * HTTPS on port 443.
 */
function isOriginAllowed(original: URL, current: URL): boolean {
  if (current.origin === original.origin) {
    return true;
  }
  return (
    current.hostname === original.hostname &&
    original.protocol === HTTP_SCHEME &&
    effectivePort(original) === HTTP_DEFAULT_PORT &&
    current.protocol === HTTPS_SCHEME &&
    effectivePort(current) === HTTPS_DEFAULT_PORT
  );
}

/** A URL's port, filled in from its scheme when the URL leaves it implicit. */
function effectivePort(url: URL): string {
  if (url.port !== '') {
    return url.port;
  }
  return url.protocol === HTTPS_SCHEME ? HTTPS_DEFAULT_PORT : HTTP_DEFAULT_PORT;
}

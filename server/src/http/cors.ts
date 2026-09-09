/**
 * Cross-origin access.
 *
 * The SPA is served from GitHub Pages (or localhost in development) and this
 * API from somewhere else, so every request the browser makes is cross-origin.
 * Without these headers the browser discards the response before the page ever
 * sees it — the request succeeds, the server logs a 200, and the app shows
 * nothing. It is a confusing failure, which is why it is worth getting right
 * once rather than debugging later.
 *
 * The origin is echoed from an allowlist rather than answered with `*`.
 * Wildcard and `Access-Control-Allow-Credentials` are mutually exclusive, and
 * more to the point: an API that returns employee records should say exactly
 * which sites may read it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.ts';

/** Origins allowed to read responses from this API. */
const allowed = new Set(config.corsOrigins);

/**
 * In development, any localhost port is allowed — Vite moves between 5173,
 * 5174 and 5175 depending on what is already running, and hard-coding one of
 * them produces a failure that looks like a code bug. Never in production.
 */
const isDevLocalhost = (origin: string): boolean =>
  config.nodeEnv !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

const isAllowed = (origin: string): boolean => allowed.has(origin) || isDevLocalhost(origin);

/**
 * Apply CORS headers, and answer a preflight outright.
 *
 * Returns true when the request has been fully handled and the caller should
 * stop — that is only ever an OPTIONS preflight.
 */
export function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;

  if (origin && isAllowed(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    // The response differs by origin, so anything caching it must key on that.
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-credentials', 'true');
  }

  if (req.method === 'OPTIONS') {
    // An unrecognised origin gets a bare 204: no allow-origin header, so the
    // browser blocks the real request. Refusing loudly would leak which
    // origins are configured.
    if (origin && isAllowed(origin)) {
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-max-age', '86400');
    }
    res.writeHead(204);
    res.end();
    return true;
  }

  return false;
}

/** Whether an origin would be accepted — used by the startup log. */
export const corsAllows = isAllowed;

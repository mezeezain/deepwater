// Shared HTTP helpers for the two worker servers: CORS allow-list, per-client rate limit, security headers.
// No dependencies.

export const DEFAULT_ORIGINS = 'https://mezeezain.github.io,http://localhost:8000,http://127.0.0.1:8000';

/** Parse "a,b" into a list; '*' means any origin. */
export function parseOrigins(value) {
  return String(value || DEFAULT_ORIGINS).split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

/** The Access-Control-Allow-Origin value for a request, or null when the origin is not allowed. */
export function corsOrigin(allowed, requestOrigin) {
  if (allowed.includes('*')) return '*';
  return requestOrigin && allowed.includes(requestOrigin) ? requestOrigin : null;
}

/** Fixed-window limiter: allow(key) is false once a key has used its quota for the current minute. */
export function rateLimiter(perMinute, now = () => Date.now()) {
  let windowStart = now();
  let counts = new Map();
  return {
    allow(key) {
      const t = now();
      if (t - windowStart >= 60_000) {
        windowStart = t;
        counts = new Map();
      }
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      return n <= perMinute;
    },
    retryAfter: () => Math.max(1, Math.ceil((windowStart + 60_000 - now()) / 1000)),
  };
}

/** Client address: the first X-Forwarded-For hop when we sit behind our own reverse proxy, else the socket. */
export function clientKey(req, trustProxy) {
  const fwd = trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

/**
 * Wrap request handling: CORS, rate limit, and security headers.
 * handler(req, res, { url, send, direct }) where direct is true for requests that did not come through a proxy.
 */
export function guardedHandler({ origins, perMinute, trustProxy, handler }) {
  const limiter = rateLimiter(perMinute);
  return (req, res) => {
    const origin = corsOrigin(origins, req.headers.origin);
    const base = {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      vary: 'Origin',
      ...(origin ? { 'access-control-allow-origin': origin } : {}),
    };
    const send = (code, body, extra = {}) => {
      res.writeHead(code, { ...base, 'content-type': 'application/json; charset=utf-8', ...extra });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...base, 'access-control-allow-methods': 'GET', 'access-control-max-age': '86400' });
      return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'GET only' }, { allow: 'GET, HEAD, OPTIONS' });
    if (!limiter.allow(clientKey(req, trustProxy))) return send(429, { error: 'Too many requests, slow down.' }, { 'retry-after': String(limiter.retryAfter()) });
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return send(400, { error: 'Bad request' });
    }
    return handler(req, res, { url, send, direct: !req.headers['x-forwarded-for'] });
  };
}

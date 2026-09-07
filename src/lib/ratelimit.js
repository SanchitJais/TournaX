/**
 * In-process rate limiting for the endpoints worth protecting: sign-in,
 * registration and anything that writes on behalf of an anonymous caller.
 *
 * A fixed-window counter keyed by IP + bucket name. Deliberately simple --
 * it exists to blunt credential stuffing and accidental request storms, not
 * to be a distributed quota system. Swap the Map for Redis if this ever runs
 * on more than one process.
 */
import { HttpError } from './http.js';

const buckets = new Map();

/** Drop windows that have rolled over so the Map cannot grow without bound. */
function sweep(now) {
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
}
let lastSweep = 0;

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * @param {string} name   bucket name, e.g. 'login'
 * @param {object} opts   { limit, windowMs, message }
 * @returns {(ctx) => void} throws HttpError 429 when the limit is exceeded
 */
export function rateLimit(name, { limit = 20, windowMs = 60_000, message } = {}) {
  return (ctx) => {
    const now = Date.now();
    if (now - lastSweep > 60_000) { sweep(now); lastSweep = now; }

    const key = `${name}:${clientIp(ctx.req)}`;
    let entry = buckets.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > limit) {
      const seconds = Math.ceil((entry.resetAt - now) / 1000);
      ctx.res.setHeader('Retry-After', String(seconds));
      throw new HttpError(429, message || `Too many requests. Try again in ${seconds}s.`);
    }
  };
}

/** Clear a bucket after a successful attempt, so honest users are not punished. */
export function resetLimit(name, req) {
  buckets.delete(`${name}:${clientIp(req)}`);
}

export const _buckets = buckets; // exposed for tests

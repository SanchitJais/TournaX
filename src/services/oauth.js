/**
 * Google Sign-In (OAuth 2.0 authorization code + OpenID Connect).
 *
 * Fully implemented, but inert until credentials are supplied:
 *
 *   GOOGLE_CLIENT_ID=...  GOOGLE_CLIENT_SECRET=...  [OAUTH_REDIRECT_BASE=https://...]
 *
 * Without them `isConfigured()` is false, the UI hides the Google button and
 * email/password sign-in continues to work exactly as before.
 *
 * The ID token is verified properly -- RS256 signature against Google's
 * published JWKS, plus issuer, audience and expiry checks. A token is never
 * trusted just because it arrived over TLS.
 */
import crypto from 'node:crypto';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

export const isConfigured = () =>
  Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export function redirectUri(req) {
  if (process.env.OAUTH_REDIRECT_BASE) {
    return `${process.env.OAUTH_REDIRECT_BASE.replace(/\/$/, '')}/api/auth/google/callback`;
  }
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || 'localhost:3000';
  return `${proto}://${host}/api/auth/google/callback`;
}

/** Opaque, unguessable value tying the callback back to this browser. */
export const createState = () => crypto.randomBytes(24).toString('hex');

export function buildAuthUrl({ req, state, prompt }) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    include_granted_scopes: 'true',
  });
  if (prompt) params.set('prompt', prompt);
  return `${AUTH_ENDPOINT}?${params}`;
}

export async function exchangeCode({ req, code }) {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(req),
    grant_type: 'authorization_code',
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google rejected the sign-in code (${res.status}): ${detail.slice(0, 200)}`);
  }
  return res.json();
}

// ------------------------------------------------------------------- JWKS --
let jwksCache = { keys: [], fetchedAt: 0 };

async function getSigningKey(kid) {
  const fresh = Date.now() - jwksCache.fetchedAt < 60 * 60 * 1000;
  if (!fresh || !jwksCache.keys.some((k) => k.kid === kid)) {
    const res = await fetch(JWKS_URI);
    if (!res.ok) throw new Error('Could not fetch Google signing keys');
    const body = await res.json();
    jwksCache = { keys: body.keys || [], fetchedAt: Date.now() };
  }
  const jwk = jwksCache.keys.find((k) => k.kid === kid);
  if (!jwk) throw new Error('Google signing key not found for this token');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

const b64urlToBuffer = (value) =>
  Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const decodeSegment = (value) => JSON.parse(b64urlToBuffer(value).toString('utf8'));

/**
 * Verify a Google ID token and return its claims.
 * Throws if the signature, issuer, audience or expiry does not check out.
 */
export async function verifyIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed ID token');

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodeSegment(headerB64);
  const claims = decodeSegment(payloadB64);

  if (header.alg !== 'RS256') throw new Error(`Unexpected token algorithm: ${header.alg}`);

  const key = await getSigningKey(header.kid);
  const signed = Buffer.from(`${headerB64}.${payloadB64}`, 'ascii');
  const valid = crypto.verify('RSA-SHA256', signed, key, b64urlToBuffer(signatureB64));
  if (!valid) throw new Error('ID token signature is not valid');

  if (!ISSUERS.has(claims.iss)) throw new Error(`Unexpected token issuer: ${claims.iss}`);
  if (claims.aud !== process.env.GOOGLE_CLIENT_ID) throw new Error('ID token was issued for a different app');

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new Error('ID token has expired');
  if (typeof claims.iat === 'number' && claims.iat > now + 300) throw new Error('ID token is not valid yet');
  if (!claims.email) throw new Error('Google did not return an email address');
  if (claims.email_verified === false) throw new Error('That Google email address is not verified');

  return claims;
}

/** Everything the sign-in route needs, in one call. */
export async function completeSignIn({ req, code }) {
  const tokens = await exchangeCode({ req, code });
  if (!tokens.id_token) throw new Error('Google did not return an ID token');
  const claims = await verifyIdToken(tokens.id_token);
  return {
    providerUserId: claims.sub,
    email: String(claims.email).toLowerCase(),
    name: claims.name || claims.given_name || String(claims.email).split('@')[0],
    picture: claims.picture || null,
    claims,
  };
}

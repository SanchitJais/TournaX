/**
 * Minimal HTTP plumbing: body parsing, JSON replies, cookies, static files.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from '../db.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const badRequest = (m, d) => new HttpError(400, m, d);
export const unauthorized = (m = 'Sign in to continue') => new HttpError(401, m);
export const forbidden = (m = 'You do not have permission to do that') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m) => new HttpError(409, m);

const MAX_BODY = 24 * 1024 * 1024; // 24 MB -- generous enough for logo data URLs

export async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw badRequest('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] || '';
  try {
    if (type.includes('application/json')) return JSON.parse(raw);
    if (type.includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(raw));
    }
    return JSON.parse(raw); // best effort -- most clients here send JSON
  } catch {
    throw badRequest('Request body was not valid JSON');
  }
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendFileDownload(res, filename, buffer, contentType) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

// ------------------------------------------------------------------ cookies --
export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, { maxAge = 60 * 60 * 24 * 30, httpOnly = true } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'SameSite=Lax',
  ];
  if (httpOnly) parts.push('HttpOnly');
  appendHeader(res, 'Set-Cookie', parts.join('; '));
}

export function clearCookie(res, name) {
  appendHeader(res, 'Set-Cookie', `${name}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`);
}

function appendHeader(res, name, value) {
  const existing = res.getHeader(name);
  if (!existing) res.setHeader(name, value);
  else res.setHeader(name, Array.isArray(existing) ? [...existing, value] : [existing, value]);
}

// ------------------------------------------------------------ static files --
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const PUBLIC_DIR = path.join(ROOT, 'public');

export function serveStatic(req, res, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = path.join(PUBLIC_DIR, decoded);
  // Containment check -- never serve outside public/
  if (!target.startsWith(PUBLIC_DIR)) return false;
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(target).toLowerCase();
  const etag = `W/"${stat.size}-${Number(stat.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304).end();
    return true;
  }
  const isUpload = decoded.startsWith('/uploads/');
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': isUpload ? 'public, max-age=604800' : 'no-cache',
  });
  fs.createReadStream(target).pipe(res);
  return true;
}

export function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-cache',
  });
  res.end(html);
}

// --------------------------------------------------------- image uploading --
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
const DATA_URL_RE = /^data:(image\/(png|jpeg|jpg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/;
const EXT_FOR = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
  'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
};

/**
 * Persist a base64 data URL to public/uploads and return its public path.
 * Values that are already plain URLs (or empty) pass straight through, so
 * callers can hand us "whatever the form had" without branching.
 */
export function saveDataUrl(value, prefix = 'img') {
  if (!value || typeof value !== 'string') return value ?? null;
  if (!value.startsWith('data:')) return value;
  const match = DATA_URL_RE.exec(value);
  if (!match) throw badRequest('Unsupported image format. Use PNG, JPG, GIF, WEBP or SVG.');
  const [, mime, , b64] = match;
  const buffer = Buffer.from(b64.replace(/\s/g, ''), 'base64');
  if (buffer.length > 4 * 1024 * 1024) throw badRequest('Image too large (max 4 MB)');
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}${EXT_FOR[mime]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  return `/uploads/${name}`;
}

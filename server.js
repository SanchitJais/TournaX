/**
 * Tournament Management & Fixture Automation -- HTTP server.
 *
 * Zero runtime dependencies: node:http for the server, node:sqlite for storage.
 * Start with `npm start`, then open http://localhost:3000
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './src/db.js';
import { createRouter } from './src/router.js';
import { purgeExpiredSessions, userFromRequest } from './src/auth.js';
import { HttpError, readBody, sendHtml, sendJson, serveStatic } from './src/lib/http.js';

import registerAuth from './src/routes/auth.js';
import registerTournaments from './src/routes/tournaments.js';
import registerTeams from './src/routes/teams.js';
import registerMatches from './src/routes/matches.js';
import registerInsights from './src/routes/insights.js';
import registerExports from './src/routes/exports.js';
import registerPublic from './src/routes/public.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const router = createRouter();
registerAuth(router);
registerTournaments(router);
registerTeams(router);
registerMatches(router);
registerInsights(router);
registerExports(router);
registerPublic(router);

const INDEX = path.join(ROOT, 'public', 'index.html');

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    // Static assets first -- they are the bulk of requests.
    if (pathname !== '/' && serveStatic(req, res, pathname)) return;

    const ctx = {
      req,
      res,
      method: req.method,
      pathname,
      url,
      query: Object.fromEntries(url.searchParams),
      body: await readBody(req),
      user: userFromRequest(req),
    };

    if (await router.handle(ctx)) {
      logLine(req, res, started);
      return;
    }

    if (pathname.startsWith('/api/')) throw new HttpError(404, `No API route for ${pathname}`);

    // Everything else is a client-side route: serve the app shell.
    sendHtml(res, 200, fs.readFileSync(INDEX, 'utf8'));
  } catch (err) {
    respondWithError(res, err, pathname);
  }
});

function respondWithError(res, err, pathname) {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(`[error] ${pathname}:`, err);
  if (res.writableEnded) return;
  sendJson(res, status, {
    error: err.message || 'Something went wrong',
    ...(err.details ? { details: err.details } : {}),
  });
}

function logLine(req, res, started) {
  if (process.env.QUIET) return;
  const ms = Date.now() - started;
  if (req.method === 'GET' && ms < 60) return;   // keep the log readable
  console.log(`${req.method} ${req.url} -> ${res.statusCode} (${ms}ms)`);
}

// Housekeeping: drop dead sessions hourly.
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 3600_000).unref();

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`\n  Tournament platform running`);
  console.log(`  Admin    http://${shown}:${PORT}/admin`);
  console.log(`  Public   http://${shown}:${PORT}/\n`);
});

process.on('SIGINT', () => { console.log('\nShutting down.'); server.close(() => process.exit(0)); });

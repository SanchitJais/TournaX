/** Tiny pattern router: `/api/teams/:id` style paths, JSON in and out. */
import { HttpError, notFound, sendJson } from './lib/http.js';

const compile = (pattern) => {
  const names = [];
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z_]\w*)/g, (_, name) => { names.push(name); return '([^/]+)'; })
    .replace(/\*/g, '.*');
  return { regex: new RegExp(`^${source}/?$`), names };
};

export function createRouter() {
  const routes = [];

  const add = (method, pattern, handler) => {
    const { regex, names } = compile(pattern);
    routes.push({ method, regex, names, handler, pattern });
  };

  const router = {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    patch: (p, h) => add('PATCH', p, h),
    delete: (p, h) => add('DELETE', p, h),

    /** Returns false when nothing matched, so the caller can fall through. */
    async handle(ctx) {
      const { method, pathname } = ctx;
      let pathMatched = false;

      for (const route of routes) {
        const match = route.regex.exec(pathname);
        if (!match) continue;
        pathMatched = true;
        if (route.method !== method) continue;

        ctx.params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(match[i + 1])]));
        const result = await route.handler(ctx);
        if (result !== undefined && !ctx.res.writableEnded) {
          sendJson(ctx.res, result?.__status || 200, strip(result));
        }
        return true;
      }

      if (pathMatched) throw new HttpError(405, `${method} is not allowed on ${pathname}`);
      return false;
    },
  };
  return router;
}

/** Lets a handler return `{ __status: 201, ... }` without leaking the key. */
function strip(result) {
  if (result && typeof result === 'object' && '__status' in result) {
    const { __status, ...rest } = result;
    return rest;
  }
  return result;
}

export const created = (payload) => ({ __status: 201, ...payload });
export { notFound };

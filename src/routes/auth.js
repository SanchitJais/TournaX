/** Sign in / out, the current user, and user + member administration. */
import { all, get, insert, run, updateRow } from '../db.js';
import {
  SESSION_COOKIE, can, createSession, createUser, destroySession, effectiveRole,
  hashPassword, requireAbility, requireUser, verifyPassword,
} from '../auth.js';
import { ROLES, ROLE_LABELS } from '../config.js';
import { badRequest, clearCookie, conflict, forbidden, notFound, setCookie } from '../lib/http.js';
import { recordAudit } from '../services/audit.js';
import { rateLimit, resetLimit } from '../lib/ratelimit.js';

// Blunts credential stuffing without getting in an honest user's way:
// a successful sign-in clears the counter.
const loginLimiter = rateLimit('login', {
  limit: 12, windowMs: 10 * 60_000,
  message: 'Too many sign-in attempts. Wait a few minutes and try again.',
});
const signupLimiter = rateLimit('signup', { limit: 8, windowMs: 60 * 60_000 });

export default function register(router) {
  router.post('/api/auth/login', (ctx) => {
    loginLimiter(ctx);
    const { body, req, res } = ctx;
    const email = String(body.email || '').trim().toLowerCase();
    const user = get('SELECT * FROM users WHERE email = ?', [email]);
    // Same message either way -- do not confirm which emails exist.
    if (!user || !verifyPassword(body.password || '', user.password_hash)) {
      throw badRequest('That email and password combination is not recognised.');
    }
    if (!user.is_active) throw forbidden('This account has been deactivated.');

    resetLimit('login', req);
    const token = createSession(user.id, req.headers['user-agent']);
    setCookie(res, SESSION_COOKIE, token);
    return { user: publicUser(user) };
  });

  router.post('/api/auth/logout', ({ user, res }) => {
    if (user?.token) destroySession(user.token);
    clearCookie(res, SESSION_COOKIE);
    return { ok: true };
  });

  router.get('/api/auth/me', ({ user }) => ({
    user: user ? publicUser(user) : null,
    roles: ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
  }));

  /**
   * Open registration creates a player account. The very first account on a
   * fresh install becomes the super admin so the platform is usable at once.
   */
  router.post('/api/auth/register', (ctx) => {
    signupLimiter(ctx);
    const { body, req, res } = ctx;
    const email = String(body.email || '').trim().toLowerCase();
    if (get('SELECT id FROM users WHERE email = ?', [email])) {
      throw conflict('An account with that email already exists.');
    }
    const isFirst = get('SELECT COUNT(*) AS n FROM users').n === 0;
    let id;
    try {
      id = createUser({ email, name: body.name, password: body.password, role: isFirst ? 'super_admin' : 'player' });
    } catch (err) {
      throw badRequest(err.message);
    }
    const token = createSession(id, req.headers['user-agent']);
    setCookie(res, SESSION_COOKIE, token);
    return { user: publicUser(get('SELECT * FROM users WHERE id = ?', [id])), first: isFirst };
  });

  // ------------------------------------------------------------- user admin --
  router.get('/api/users', (ctx) => {
    requireUser(ctx);
    if (ctx.user.role !== 'super_admin') throw forbidden('Only a super admin can list users.');
    return {
      users: all(
        `SELECT id, email, name, role, avatar_url, is_active, created_at, last_login_at
           FROM users ORDER BY role, name`,
      ),
    };
  });

  router.post('/api/users', (ctx) => {
    if (ctx.user?.role !== 'super_admin') throw forbidden('Only a super admin can create users.');
    const email = String(ctx.body.email || '').trim().toLowerCase();
    if (get('SELECT id FROM users WHERE email = ?', [email])) throw conflict('That email is already registered.');
    let id;
    try {
      id = createUser({ email, name: ctx.body.name, password: ctx.body.password, role: ctx.body.role });
    } catch (err) {
      throw badRequest(err.message);
    }
    recordAudit({ actor: ctx.user, action: 'user.created', entity: 'user', entityId: id, summary: `Created user ${email}.` });
    return { user: publicUser(get('SELECT * FROM users WHERE id = ?', [id])) };
  });

  router.patch('/api/users/:id', (ctx) => {
    if (ctx.user?.role !== 'super_admin') throw forbidden('Only a super admin can edit users.');
    const id = Number(ctx.params.id);
    const target = get('SELECT * FROM users WHERE id = ?', [id]);
    if (!target) throw notFound('User not found');

    const fields = {
      name: ctx.body.name,
      role: ROLES.includes(ctx.body.role) ? ctx.body.role : undefined,
      is_active: ctx.body.is_active === undefined ? undefined : (ctx.body.is_active ? 1 : 0),
    };
    if (ctx.body.password) {
      if (String(ctx.body.password).length < 8) throw badRequest('Password must be at least 8 characters.');
      fields.password_hash = hashPassword(ctx.body.password);
    }
    // Never let the last super admin lock everyone out.
    if (target.role === 'super_admin' && (fields.role && fields.role !== 'super_admin' || fields.is_active === 0)) {
      const others = get("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND is_active = 1 AND id != ?", [id]).n;
      if (!others) throw badRequest('This is the only active super admin; promote another account first.');
    }
    updateRow('users', id, fields, ['name', 'role', 'is_active', 'password_hash']);
    if (fields.is_active === 0) run('DELETE FROM sessions WHERE user_id = ?', [id]);

    recordAudit({ actor: ctx.user, action: 'user.updated', entity: 'user', entityId: id, summary: `Updated user ${target.email}.` });
    return { user: publicUser(get('SELECT * FROM users WHERE id = ?', [id])) };
  });

  router.delete('/api/users/:id', (ctx) => {
    if (ctx.user?.role !== 'super_admin') throw forbidden('Only a super admin can remove users.');
    const id = Number(ctx.params.id);
    if (id === ctx.user.id) throw badRequest('You cannot delete your own account.');
    const target = get('SELECT * FROM users WHERE id = ?', [id]);
    if (!target) throw notFound('User not found');
    run('DELETE FROM users WHERE id = ?', [id]);
    recordAudit({ actor: ctx.user, action: 'user.deleted', entity: 'user', entityId: id, summary: `Deleted user ${target.email}.` });
    return { ok: true };
  });

  // ------------------------------------------------- per-tournament members --
  router.get('/api/tournaments/:id/members', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'tournament:write', tournamentId);
    return {
      members: all(
        `SELECT tm.id, tm.role, tm.team_id, u.id AS user_id, u.name, u.email, t.name AS team_name
           FROM tournament_members tm
           JOIN users u ON u.id = tm.user_id
           LEFT JOIN teams t ON t.id = tm.team_id
          WHERE tm.tournament_id = ? ORDER BY tm.role, u.name`,
        [tournamentId],
      ),
    };
  });

  router.post('/api/tournaments/:id/members', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'tournament:write', tournamentId);

    const email = String(ctx.body.email || '').trim().toLowerCase();
    let user = get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      if (!ctx.body.password) throw badRequest('That user does not exist yet. Supply a password to create the account.');
      const id = createUser({ email, name: ctx.body.name, password: ctx.body.password, role: ctx.body.role });
      user = get('SELECT * FROM users WHERE id = ?', [id]);
    }
    const role = ROLES.includes(ctx.body.role) ? ctx.body.role : 'scorekeeper';
    const teamId = ctx.body.team_id ? Number(ctx.body.team_id) : null;
    try {
      insert(
        'INSERT INTO tournament_members (tournament_id, user_id, role, team_id) VALUES (?, ?, ?, ?)',
        [tournamentId, user.id, role, teamId],
      );
    } catch {
      throw conflict('That user already has this access.');
    }
    recordAudit({
      tournamentId, actor: ctx.user, action: 'member.added', entity: 'user', entityId: user.id,
      summary: `Granted ${ROLE_LABELS[role] || role} access to ${user.email}.`,
    });
    return { ok: true };
  });

  router.delete('/api/tournaments/:tid/members/:id', (ctx) => {
    const tournamentId = Number(ctx.params.tid);
    requireAbility(ctx, 'tournament:write', tournamentId);
    run('DELETE FROM tournament_members WHERE id = ? AND tournament_id = ?', [Number(ctx.params.id), tournamentId]);
    return { ok: true };
  });

  /** What the signed-in user may do here -- the UI hides what it cannot use. */
  router.get('/api/tournaments/:id/abilities', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    const abilities = [
      'tournament:write', 'teams:write', 'fixtures:write', 'matches:write',
      'results:write', 'qualification:write', 'stages:write', 'export', 'audit:read',
      'notifications:write', 'templates:write',
    ];
    return {
      role: effectiveRole(ctx.user, tournamentId),
      abilities: Object.fromEntries(abilities.map((a) => [a, can(ctx.user, a, tournamentId)])),
    };
  });
}

const publicUser = (u) => ({
  id: u.id, email: u.email, name: u.name, role: u.role,
  avatar_url: u.avatar_url, is_active: u.is_active,
});

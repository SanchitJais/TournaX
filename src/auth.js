/** Sessions, password hashing and the role/ability check used by every route. */
import crypto from 'node:crypto';
import { all, get, insert, run } from './db.js';
import { ROLE_ABILITIES, ROLES } from './config.js';
import { forbidden, parseCookies, unauthorized } from './lib/http.js';

const SESSION_COOKIE = 'tms_session';
const SESSION_DAYS = 30;

// ------------------------------------------------------------------ hashing --
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password, stored) {
  if (!stored?.startsWith('scrypt$')) return false;
  const [, salt, expected] = stored.split('$');
  const derived = crypto.scryptSync(String(password), salt, 64);
  const expectedBuf = Buffer.from(expected, 'hex');
  // Length check first: timingSafeEqual throws on a mismatch.
  return derived.length === expectedBuf.length && crypto.timingSafeEqual(derived, expectedBuf);
}

// ----------------------------------------------------------------- sessions --
export function createSession(userId, userAgent) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString().replace('T', ' ').slice(0, 19);
  insert(
    'INSERT INTO sessions (token, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)',
    [token, userId, expires, (userAgent || '').slice(0, 200)],
  );
  run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [userId]);
  return token;
}

export const destroySession = (token) => run('DELETE FROM sessions WHERE token = ?', [token]);

export function userFromRequest(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const row = get(
    `SELECT u.id, u.email, u.name, u.role, u.avatar_url, u.is_active, s.token
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > datetime('now')`,
    [token],
  );
  if (!row || !row.is_active) return null;
  return row;
}

export const purgeExpiredSessions = () => run("DELETE FROM sessions WHERE expires_at <= datetime('now')");

export { SESSION_COOKIE };

// ------------------------------------------------------------- authorisation --
/** Per-tournament grant, if the user has one. */
export function membershipRole(userId, tournamentId) {
  if (!userId || !tournamentId) return null;
  const row = get(
    'SELECT role FROM tournament_members WHERE user_id = ? AND tournament_id = ? ORDER BY id LIMIT 1',
    [userId, tournamentId],
  );
  return row?.role || null;
}

/** The role that actually applies in this context. */
export function effectiveRole(user, tournamentId) {
  if (!user) return 'spectator';
  if (user.role === 'super_admin') return 'super_admin';
  return membershipRole(user.id, tournamentId) || user.role;
}

/**
 * Capability check. Tournament owners always have full control of their own
 * tournament, which keeps the common case free of explicit member rows.
 */
export function can(user, ability, tournamentId = null) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;

  if (tournamentId) {
    const owner = get('SELECT owner_id FROM tournaments WHERE id = ?', [tournamentId]);
    if (owner && owner.owner_id === user.id) return true;
  }

  const abilities = ROLE_ABILITIES[effectiveRole(user, tournamentId)] || [];
  return abilities.includes('*') || abilities.includes(ability);
}

export function requireUser(ctx) {
  if (!ctx.user) throw unauthorized();
  return ctx.user;
}

export function requireAbility(ctx, ability, tournamentId = null) {
  requireUser(ctx);
  if (!can(ctx.user, ability, tournamentId)) {
    throw forbidden(`Your role (${effectiveRole(ctx.user, tournamentId)}) cannot perform this action.`);
  }
  return ctx.user;
}

/** Teams a team_manager is attached to, used to scope what they can see. */
export const managedTeamIds = (userId, tournamentId) =>
  all(
    'SELECT team_id FROM tournament_members WHERE user_id = ? AND tournament_id = ? AND team_id IS NOT NULL',
    [userId, tournamentId],
  ).map((r) => r.team_id);

export function createUser({ email, name, password, role = 'spectator' }) {
  const normalisedEmail = String(email || '').trim().toLowerCase();
  if (!normalisedEmail.includes('@')) throw new Error('A valid email address is required');
  if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters');
  const safeRole = ROLES.includes(role) ? role : 'spectator';
  return insert(
    'INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)',
    [normalisedEmail, String(name || normalisedEmail.split('@')[0]).slice(0, 80), hashPassword(password), safeRole],
  );
}

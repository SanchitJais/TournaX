/** Google sign-in, player profiles, and the signed-in player's own dashboard. */
import crypto from 'node:crypto';
import { all, get, insert, run, toJson, parseJson, tx } from '../db.js';
import { SESSION_COOKIE, createSession, requireUser } from '../auth.js';
import { GAMES, ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS } from '../config.js';
import {
  badRequest, clearCookie, forbidden, notFound, parseCookies, redirect, saveDataUrl, setCookie,
} from '../lib/http.js';
import { rateLimit, resetLimit } from '../lib/ratelimit.js';
import * as oauth from '../services/oauth.js';
import { invitesForUser, respondToInvite, squadsForUser, members } from '../services/squads.js';
import { tournamentsForUser } from '../services/registrations.js';
import { playerCareer } from '../services/stats.js';
import { listUserNotifications, markAllRead, markRead, userUnreadCount } from '../services/notify.js';
import { recordAudit } from '../services/audit.js';

const OAUTH_STATE_COOKIE = 'tms_oauth_state';
const oauthLimiter = rateLimit('oauth', { limit: 20, windowMs: 5 * 60_000 });

export function profileFor(userId) {
  const row = get('SELECT * FROM player_profiles WHERE user_id = ?', [userId]);
  return row ? { ...row, socials: parseJson(row.socials, {}) } : null;
}

/** The three starred fields decide whether a profile counts as complete. */
const isComplete = (p) => Boolean(p?.full_name?.trim() && p?.ign?.trim() && p?.phone?.trim());

export default function register(router) {
  // ------------------------------------------------------ Google sign-in --
  router.get('/api/auth/google', (ctx) => {
    oauthLimiter(ctx);
    if (!oauth.isConfigured()) {
      throw badRequest('Google sign-in is not configured on this server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
    }
    const state = oauth.createState();
    // Bound to this browser so a stolen callback URL cannot be replayed.
    setCookie(ctx.res, OAUTH_STATE_COOKIE, state, { maxAge: 600 });
    redirect(ctx.res, oauth.buildAuthUrl({ req: ctx.req, state, prompt: ctx.query.prompt }));
  });

  router.get('/api/auth/google/callback', async (ctx) => {
    oauthLimiter(ctx);
    const fail = (message) => redirect(ctx.res, `/login?error=${encodeURIComponent(message)}`);

    if (ctx.query.error) return fail(`Google sign-in was cancelled (${ctx.query.error}).`);
    if (!oauth.isConfigured()) return fail('Google sign-in is not configured.');

    const expected = parseCookies(ctx.req)[OAUTH_STATE_COOKIE];
    clearCookie(ctx.res, OAUTH_STATE_COOKIE);
    if (!expected || expected !== ctx.query.state) {
      return fail('Sign-in session expired. Please try again.');
    }
    if (!ctx.query.code) return fail('Google did not return an authorization code.');

    let identity;
    try {
      identity = await oauth.completeSignIn({ req: ctx.req, code: ctx.query.code });
    } catch (err) {
      console.error('[oauth] sign-in failed:', err.message);
      return fail(err.message);
    }

    const user = upsertGoogleUser(identity);
    const token = createSession(user.id, ctx.req.headers['user-agent']);
    setCookie(ctx.res, SESSION_COOKIE, token);

    const profile = profileFor(user.id);
    return redirect(ctx.res, isComplete(profile) ? '/me' : '/me/profile?welcome=1');
  });

  /** Lets the sign-in screen decide whether to show the Google button. */
  router.get('/api/auth/providers', () => ({
    google: oauth.isConfigured(),
    password: true,
  }));

  // ------------------------------------------------------------- profile --
  router.get('/api/me', (ctx) => {
    if (!ctx.user) return { user: null };
    const profile = profileFor(ctx.user.id);
    return {
      user: {
        id: ctx.user.id, name: ctx.user.name, email: ctx.user.email,
        role: ctx.user.role, avatar_url: ctx.user.avatar_url,
      },
      profile,
      profile_complete: isComplete(profile),
      squads: squadsForUser(ctx.user.id),
      invites: invitesForUser(ctx.user).length,
      unread: userUnreadCount(ctx.user.id),
      roles: ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r], description: ROLE_DESCRIPTIONS[r] })),
      games: GAMES,
    };
  });

  router.put('/api/me/profile', (ctx) => {
    const user = requireUser(ctx);
    const body = ctx.body || {};

    const fullName = String(body.full_name || '').trim();
    const ign = String(body.ign || '').trim();
    const phone = String(body.phone || '').trim();

    // Server-side validation: the client marks these with a star, but the
    // rule is enforced here so the API cannot be bypassed.
    const missing = [];
    if (fullName.length < 2) missing.push('Full Name');
    if (ign.length < 2) missing.push('In-Game Name');
    if (!/^[+()\d][\d\s()-]{5,19}$/.test(phone)) missing.push('Phone Number');
    if (missing.length) {
      throw badRequest(`These fields are required: ${missing.join(', ')}.`, { fields: missing });
    }

    const avatar = body.avatar_url ? saveDataUrl(body.avatar_url, 'avatar') : undefined;
    const socials = toJson({
      youtube: body.youtube || null, instagram: body.instagram || null,
      x: body.x || null, twitch: body.twitch || null,
    });

    tx(() => {
      run(
        `INSERT INTO player_profiles
           (user_id, full_name, ign, in_game_id, phone, alt_contact, game, country, region,
            discord, socials, avatar_url, bio, is_complete, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           full_name = excluded.full_name, ign = excluded.ign, in_game_id = excluded.in_game_id,
           phone = excluded.phone, alt_contact = excluded.alt_contact, game = excluded.game,
           country = excluded.country, region = excluded.region, discord = excluded.discord,
           socials = excluded.socials,
           avatar_url = COALESCE(excluded.avatar_url, player_profiles.avatar_url),
           bio = excluded.bio, is_complete = 1, updated_at = datetime('now')`,
        [
          user.id, fullName, ign, body.in_game_id || null, phone, body.alt_contact || null,
          body.game || 'BGMI', body.country || null, body.region || null, body.discord || null,
          socials, avatar ?? null, body.bio || null,
        ],
      );
      run('UPDATE users SET profile_complete = 1 WHERE id = ?', [user.id]);
      if (body.name) run('UPDATE users SET name = ? WHERE id = ?', [String(body.name).slice(0, 80), user.id]);
      if (avatar) run('UPDATE users SET avatar_url = ? WHERE id = ?', [avatar, user.id]);
    });

    recordAudit({ actor: user, action: 'profile.updated', entity: 'user', entityId: user.id, summary: 'Updated player profile.' });
    return { profile: profileFor(user.id), profile_complete: true };
  });

  /** Public player profile. Contact details are never included. */
  router.get('/api/players/:id', (ctx) => {
    const id = Number(ctx.params.id);
    const row = get(
      `SELECT u.id, u.name, p.ign, p.in_game_id, p.country, p.region, p.game, p.discord,
              p.socials, p.avatar_url, p.bio
         FROM users u JOIN player_profiles p ON p.user_id = u.id
        WHERE u.id = ? AND u.is_active = 1`,
      [id],
    );
    if (!row) throw notFound('Player not found');
    return {
      player: { ...row, socials: parseJson(row.socials, {}) },
      career: playerCareer(id),
      squads: squadsForUser(id).map((s) => ({ id: s.id, name: s.name, slug: s.slug, tag: s.tag, logo_url: s.logo_url, role: s.my_role })),
    };
  });

  // ----------------------------------------------------------- dashboard --
  router.get('/api/me/dashboard', (ctx) => {
    const user = requireUser(ctx);
    const squads = squadsForUser(user.id);
    const tournaments = tournamentsForUser(user.id);

    const teamIds = tournaments.map((t) => t.team_id).filter(Boolean);
    const matches = teamIds.length ? upcomingMatchesForTeams(teamIds, user.id) : [];

    const now = new Date();
    const bucket = (t) => {
      if (t.status === 'completed' || t.status === 'archived') return 'completed';
      if (t.status === 'live') return 'live';
      const start = t.start_date ? new Date(`${t.start_date}T00:00:00`) : null;
      return start && start > now ? 'upcoming' : 'active';
    };

    return {
      profile_complete: isComplete(profileFor(user.id)),
      squads,
      invites: invitesForUser(user),
      tournaments: {
        all: tournaments,
        live: tournaments.filter((t) => bucket(t) === 'live'),
        upcoming: tournaments.filter((t) => bucket(t) === 'upcoming'),
        active: tournaments.filter((t) => bucket(t) === 'active'),
        completed: tournaments.filter((t) => bucket(t) === 'completed'),
      },
      matches,
      career: playerCareer(user.id),
      unread: userUnreadCount(user.id),
    };
  });

  /** My matches, with room details only once they are due to be revealed. */
  router.get('/api/me/matches', (ctx) => {
    const user = requireUser(ctx);
    const teamIds = all(
      `SELECT DISTINCT t.id FROM teams t
         JOIN squad_members sm ON sm.squad_id = t.squad_id AND sm.user_id = ? AND sm.status = 'active'`,
      [user.id],
    ).map((r) => r.id);
    return { matches: teamIds.length ? upcomingMatchesForTeams(teamIds, user.id) : [] };
  });

  // ------------------------------------------------------------- invites --
  router.get('/api/me/invites', (ctx) => {
    const user = requireUser(ctx);
    return { invites: invitesForUser(user) };
  });

  router.post('/api/me/invites/:id', (ctx) => {
    const user = requireUser(ctx);
    const result = respondToInvite({ inviteId: ctx.params.id, user, accept: ctx.body?.accept !== false });
    return result;
  });

  // ------------------------------------------------------- notifications --
  router.get('/api/me/notifications', (ctx) => {
    const user = requireUser(ctx);
    return {
      notifications: listUserNotifications(user.id, { limit: Number(ctx.query.limit) || 50 }),
      unread: userUnreadCount(user.id),
    };
  });

  router.post('/api/me/notifications/read', (ctx) => {
    requireUser(ctx);
    markRead((ctx.body?.ids || []).map(Number).filter(Boolean));
    return { ok: true };
  });

  router.post('/api/me/notifications/read-all', (ctx) => {
    const user = requireUser(ctx);
    run("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL", [user.id]);
    return { ok: true };
  });
}

// --------------------------------------------------------------- helpers --
function upsertGoogleUser({ providerUserId, email, name, picture }) {
  const link = get('SELECT * FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?', ['google', providerUserId]);
  if (link) {
    const existing = get('SELECT * FROM users WHERE id = ?', [link.user_id]);
    if (existing) {
      if (picture && !existing.avatar_url) run('UPDATE users SET avatar_url = ? WHERE id = ?', [picture, existing.id]);
      return existing;
    }
  }

  // Link to an existing password account with the same verified email rather
  // than creating a duplicate identity for the same person.
  let user = get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) {
    const isFirst = get('SELECT COUNT(*) AS n FROM users').n === 0;
    const id = insert(
      'INSERT INTO users (email, name, password_hash, role, avatar_url) VALUES (?, ?, ?, ?, ?)',
      [
        email, name.slice(0, 80),
        // No usable password: this account signs in through Google.
        `oauth$${crypto.randomBytes(24).toString('hex')}`,
        isFirst ? 'super_admin' : 'player',
        picture || null,
      ],
    );
    user = get('SELECT * FROM users WHERE id = ?', [id]);
    recordAudit({ actor: user, action: 'user.created', entity: 'user', entityId: id, summary: `${email} signed up with Google.` });
  }

  insert(
    'INSERT OR IGNORE INTO oauth_accounts (user_id, provider, provider_user_id, email) VALUES (?, ?, ?, ?)',
    [user.id, 'google', providerUserId, email],
  );
  return user;
}

function upcomingMatchesForTeams(teamIds, userId) {
  const placeholders = teamIds.map(() => '?').join(',');
  const rows = all(
    `SELECT m.*, t.name AS tournament_name, t.slug AS tournament_slug, t.default_reveal_minutes,
            s.name AS stage_name, r.name AS round_name, g.name AS group_name,
            mp.team_id AS my_team_id, tm.name AS my_team_name
       FROM match_participants mp
       JOIN matches m ON m.id = mp.match_id
       JOIN tournaments t ON t.id = m.tournament_id
       JOIN teams tm ON tm.id = mp.team_id
       JOIN stages s ON s.id = m.stage_id
       LEFT JOIN rounds r ON r.id = m.round_id
       LEFT JOIN groups g ON g.id = m.group_id
      WHERE mp.team_id IN (${placeholders})
      ORDER BY m.scheduled_at, m.match_no
      LIMIT 60`,
    teamIds,
  );

  return rows.map((m) => {
    const reveal = credentialsVisible(m);
    const result = get(
      'SELECT placement, kills, total_points FROM match_results WHERE match_id = ? AND team_id = ?',
      [m.id, m.my_team_id],
    );
    return {
      id: m.id, match_no: m.match_no, label: m.label, map: m.map, status: m.status,
      scheduled_at: m.scheduled_at,
      tournament_name: m.tournament_name, tournament_slug: m.tournament_slug,
      stage_name: m.stage_name, round_name: m.round_name, group_name: m.group_name,
      my_team_id: m.my_team_id, my_team_name: m.my_team_name,
      room_id: reveal.visible ? m.room_id : null,
      room_password: reveal.visible ? m.room_password : null,
      credentials: reveal,
      result: result || null,
      opponents: get('SELECT COUNT(*) AS n FROM match_participants WHERE match_id = ?', [m.id]).n - 1,
    };
  });
}

/**
 * Room credential visibility for a participant.
 * Mirrors the rule in routes/matches.js: policy plus the explicit reveal time.
 */
export function credentialsVisible(match) {
  if (!match.room_id && !match.room_password) return { visible: false, reason: 'not_set' };

  const policy = match.reveal_policy || 'manual';
  if (policy === 'immediate') return { visible: true, policy };

  const explicit = match.credentials_reveal_at
    ? new Date(String(match.credentials_reveal_at).replace(' ', 'T'))
    : null;
  if (explicit) {
    return explicit <= new Date()
      ? { visible: true, policy }
      : { visible: false, policy, reveal_at: match.credentials_reveal_at };
  }

  if (policy === 'minutes' && match.scheduled_at) {
    const start = new Date(String(match.scheduled_at).replace(' ', 'T'));
    const minutes = match.reveal_minutes_before ?? match.default_reveal_minutes ?? 15;
    const opensAt = new Date(start.getTime() - minutes * 60000);
    return opensAt <= new Date()
      ? { visible: true, policy, minutes }
      : { visible: false, policy, minutes, reveal_at: fmtLocal(opensAt) };
  }

  return { visible: false, policy, reason: 'manual' };
}

const pad = (n) => String(n).padStart(2, '0');
const fmtLocal = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

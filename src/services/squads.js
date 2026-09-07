/**
 * Persistent teams ("squads") that live across tournaments.
 *
 * A squad owns its roster and identity; the existing per-tournament `teams`
 * row is that squad's entry in one event. Keeping the two separate is what
 * gives a team a history, cumulative statistics and a profile page, while
 * leaving tournaments that were created before squads existed untouched.
 */
import { all, get, insert, run, tx } from '../db.js';
import { SQUAD_MEMBER_ROLES } from '../config.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http.js';
import { recordAudit } from './audit.js';
import { notify } from './notify.js';

export function slugify(name, suffix = '') {
  const base = String(name || 'team').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'team';
  return suffix ? `${base}-${suffix}` : base;
}

function uniqueSlug(name) {
  let slug = slugify(name);
  let n = 1;
  while (get('SELECT id FROM squads WHERE slug = ?', [slug])) slug = slugify(name, ++n);
  return slug;
}

// ------------------------------------------------------------------ reads --
export function squadById(id) {
  return get('SELECT * FROM squads WHERE id = ?', [Number(id)]);
}

export function squadBySlug(slug) {
  return get('SELECT * FROM squads WHERE slug = ? OR id = ?', [slug, Number(slug) || 0]);
}

export function members(squadId, { includeInactive = false } = {}) {
  return all(
    `SELECT sm.id, sm.role, sm.status, sm.joined_at, u.id AS user_id, u.name, u.email, u.avatar_url,
            p.ign, p.in_game_id, p.phone, p.country, p.region, p.discord, p.avatar_url AS profile_avatar
       FROM squad_members sm
       JOIN users u ON u.id = sm.user_id
       LEFT JOIN player_profiles p ON p.user_id = u.id
      WHERE sm.squad_id = ?${includeInactive ? '' : " AND sm.status = 'active'"}
      ORDER BY CASE sm.role WHEN 'captain' THEN 0 WHEN 'player' THEN 1 ELSE 2 END, sm.joined_at`,
    [squadId],
  );
}

/** Squads the user is an active member of, with their role. */
export function squadsForUser(userId) {
  return all(
    `SELECT s.*, sm.role AS my_role,
            (SELECT COUNT(*) FROM squad_members m2 WHERE m2.squad_id = s.id AND m2.status = 'active') AS member_count
       FROM squad_members sm JOIN squads s ON s.id = sm.squad_id
      WHERE sm.user_id = ? AND sm.status = 'active'
      ORDER BY s.name`,
    [userId],
  );
}

export const isCaptain = (squadId, userId) => {
  const squad = squadById(squadId);
  if (squad?.owner_id === userId) return true;
  const row = get(
    "SELECT role FROM squad_members WHERE squad_id = ? AND user_id = ? AND status = 'active'",
    [squadId, userId],
  );
  return row?.role === 'captain';
};

export function requireCaptain(squadId, user) {
  if (!user) throw forbidden('Sign in first.');
  if (user.role === 'super_admin') return;
  if (!isCaptain(squadId, user.id)) throw forbidden('Only the team captain can do that.');
}

// ----------------------------------------------------------------- writes --
export function createSquad({ name, tag, logo_url, game, region, bio, ownerId, team_code }, actor) {
  const cleanName = String(name || '').trim();
  if (cleanName.length < 2) throw badRequest('Give the team a name.');
  if (get('SELECT id FROM squads WHERE name = ?', [cleanName])) {
    throw conflict(`A team called "${cleanName}" already exists. Ask its captain for an invite.`);
  }

  const id = tx(() => {
    const squadId = insert(
      `INSERT INTO squads (name, slug, tag, logo_url, game, owner_id, team_code, region, bio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cleanName, uniqueSlug(cleanName), tag || null, logo_url || null, game || 'BGMI',
        ownerId, team_code || null, region || null, bio || null],
    );
    insert(
      "INSERT INTO squad_members (squad_id, user_id, role, status) VALUES (?, ?, 'captain', 'active')",
      [squadId, ownerId],
    );
    return squadId;
  });

  recordAudit({ actor, action: 'squad.created', entity: 'squad', entityId: id, summary: `Created team "${cleanName}".` });
  return squadById(id);
}

export function updateSquad(squadId, fields, actor) {
  const squad = squadById(squadId);
  if (!squad) throw notFound('Team not found');

  if (fields.name && fields.name !== squad.name) {
    if (get('SELECT id FROM squads WHERE name = ? AND id != ?', [fields.name, squadId])) {
      throw conflict('Another team already uses that name.');
    }
  }
  const sets = [];
  const params = [];
  for (const key of ['name', 'tag', 'logo_url', 'game', 'region', 'bio', 'team_code']) {
    if (fields[key] === undefined) continue;
    sets.push(`${key} = ?`);
    params.push(fields[key] || null);
  }
  if (!sets.length) return squad;
  params.push(squadId);
  run(`UPDATE squads SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, params);

  recordAudit({ actor, action: 'squad.updated', entity: 'squad', entityId: squadId, summary: `Updated team "${squad.name}".` });
  return squadById(squadId);
}

// ---------------------------------------------------------------- invites --
export function invite({ squadId, email, userId, role = 'player', message }, actor) {
  const squad = squadById(squadId);
  if (!squad) throw notFound('Team not found');
  if (!SQUAD_MEMBER_ROLES.includes(role)) throw badRequest('Unknown team role.');

  let targetUser = null;
  if (userId) targetUser = get('SELECT * FROM users WHERE id = ?', [Number(userId)]);
  else if (email) targetUser = get('SELECT * FROM users WHERE email = ?', [String(email).trim().toLowerCase()]);
  if (!targetUser && !email) throw badRequest('Enter the player\'s email address.');

  if (targetUser) {
    const existing = get(
      "SELECT status FROM squad_members WHERE squad_id = ? AND user_id = ?",
      [squadId, targetUser.id],
    );
    if (existing?.status === 'active') throw conflict('That player is already in this team.');
    const pending = get(
      "SELECT id FROM squad_invites WHERE squad_id = ? AND invited_user_id = ? AND status = 'pending'",
      [squadId, targetUser.id],
    );
    if (pending) throw conflict('That player already has a pending invitation.');
  }

  const id = insert(
    `INSERT INTO squad_invites (squad_id, invited_user_id, invited_email, invited_by, role, message)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [squadId, targetUser?.id ?? null, String(email || targetUser?.email || '').toLowerCase(), actor?.id ?? null, role, message || null],
  );

  if (targetUser) {
    notify({
      tournamentId: null,
      userId: targetUser.id,
      type: 'squad.invite',
      title: `${squad.name} invited you to join`,
      body: message || `You have been invited as a ${role}.`,
      link: '/me/invites',
      severity: 'info',
    });
  }
  recordAudit({
    actor, action: 'squad.invited', entity: 'squad', entityId: squadId,
    summary: `Invited ${email || targetUser?.email} to "${squad.name}" as ${role}.`,
  });
  return get('SELECT * FROM squad_invites WHERE id = ?', [id]);
}

/** Invitations addressed to this user, by id or by the email they signed up with. */
export function invitesForUser(user) {
  return all(
    `SELECT i.*, s.name AS squad_name, s.tag, s.slug, s.logo_url, u.name AS invited_by_name
       FROM squad_invites i
       JOIN squads s ON s.id = i.squad_id
       LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.status = 'pending' AND (i.invited_user_id = ? OR i.invited_email = ?)
      ORDER BY i.created_at DESC`,
    [user.id, String(user.email || '').toLowerCase()],
  );
}

export function respondToInvite({ inviteId, user, accept }) {
  const invite = get('SELECT * FROM squad_invites WHERE id = ?', [Number(inviteId)]);
  if (!invite) throw notFound('Invitation not found');
  if (invite.status !== 'pending') throw badRequest('That invitation has already been answered.');

  const addressedToMe = invite.invited_user_id === user.id
    || (invite.invited_email && invite.invited_email === String(user.email).toLowerCase());
  if (!addressedToMe) throw forbidden('That invitation is not addressed to you.');

  tx(() => {
    run(
      "UPDATE squad_invites SET status = ?, responded_at = datetime('now'), invited_user_id = ? WHERE id = ?",
      [accept ? 'accepted' : 'rejected', user.id, invite.id],
    );
    if (!accept) return;
    const existing = get('SELECT id FROM squad_members WHERE squad_id = ? AND user_id = ?', [invite.squad_id, user.id]);
    if (existing) {
      run("UPDATE squad_members SET status = 'active', role = ? WHERE id = ?", [invite.role, existing.id]);
    } else {
      insert(
        "INSERT INTO squad_members (squad_id, user_id, role, status) VALUES (?, ?, ?, 'active')",
        [invite.squad_id, user.id, invite.role],
      );
    }
  });

  const squad = squadById(invite.squad_id);
  if (accept && squad?.owner_id) {
    notify({
      tournamentId: null, userId: squad.owner_id, type: 'squad.invite',
      title: `${user.name} joined ${squad.name}`, severity: 'success', link: `/team/${squad.slug}`,
    });
  }
  return { squad, accepted: Boolean(accept) };
}

export function leaveSquad({ squadId, user }) {
  const squad = squadById(squadId);
  if (!squad) throw notFound('Team not found');
  if (squad.owner_id === user.id) {
    throw badRequest('You own this team. Transfer ownership to another member before leaving.');
  }
  run("UPDATE squad_members SET status = 'left' WHERE squad_id = ? AND user_id = ?", [squadId, user.id]);
  recordAudit({ actor: user, action: 'squad.left', entity: 'squad', entityId: squadId, summary: `${user.name} left "${squad.name}".` });
  return { ok: true };
}

export function removeMember({ squadId, memberUserId, actor }) {
  const squad = squadById(squadId);
  if (!squad) throw notFound('Team not found');
  if (squad.owner_id === Number(memberUserId)) throw badRequest('The team owner cannot be removed.');
  run("UPDATE squad_members SET status = 'removed' WHERE squad_id = ? AND user_id = ?", [squadId, Number(memberUserId)]);
  const who = get('SELECT name FROM users WHERE id = ?', [Number(memberUserId)]);
  recordAudit({
    actor, action: 'squad.member_removed', entity: 'squad', entityId: squadId,
    summary: `Removed ${who?.name || `user ${memberUserId}`} from "${squad.name}".`,
  });
  return { ok: true };
}

export function setMemberRole({ squadId, memberUserId, role, actor }) {
  if (!SQUAD_MEMBER_ROLES.includes(role)) throw badRequest('Unknown team role.');
  run(
    "UPDATE squad_members SET role = ? WHERE squad_id = ? AND user_id = ? AND status = 'active'",
    [role, squadId, Number(memberUserId)],
  );
  if (role === 'captain') run('UPDATE squads SET owner_id = ? WHERE id = ?', [Number(memberUserId), squadId]);
  recordAudit({ actor, action: 'squad.role_changed', entity: 'squad', entityId: squadId, summary: `Set role to ${role}.` });
  return { ok: true };
}

// ------------------------------------------------------- history and stats --
/**
 * Cumulative team statistics, derived from match results across every
 * tournament this squad has entered. Nothing is stored.
 */
export function squadStats(squadId) {
  const row = get(
    `SELECT COUNT(DISTINCT r.match_id)         AS matches,
            COALESCE(SUM(r.is_win), 0)         AS wins,
            COALESCE(SUM(r.kills), 0)          AS kills,
            COALESCE(SUM(r.total_points), 0)   AS points,
            MIN(r.placement)                   AS best_placement
       FROM match_results r
       JOIN matches m ON m.id = r.match_id
       JOIN teams t ON t.id = r.team_id
      WHERE t.squad_id = ? AND m.status = 'completed'`,
    [squadId],
  ) || {};

  const matches = row.matches || 0;
  return {
    matches,
    wins: row.wins || 0,
    kills: row.kills || 0,
    points: Math.round((row.points || 0) * 100) / 100,
    best_placement: row.best_placement ?? null,
    avg_points: matches ? Math.round(((row.points || 0) / matches) * 100) / 100 : 0,
    avg_kills: matches ? Math.round(((row.kills || 0) / matches) * 100) / 100 : 0,
    tournaments: get('SELECT COUNT(DISTINCT tournament_id) AS n FROM teams WHERE squad_id = ?', [squadId]).n,
  };
}

/** Every tournament this squad has entered, newest first. */
export function squadHistory(squadId) {
  return all(
    `SELECT t.id AS team_id, t.status AS team_status, t.tournament_id,
            tn.name, tn.slug, tn.game, tn.status AS tournament_status, tn.start_date, tn.logo_url,
            (SELECT COUNT(*) FROM match_results r JOIN matches m ON m.id = r.match_id
              WHERE r.team_id = t.id AND m.status = 'completed') AS matches_played,
            (SELECT COALESCE(SUM(r.total_points), 0) FROM match_results r JOIN matches m ON m.id = r.match_id
              WHERE r.team_id = t.id AND m.status = 'completed') AS points
       FROM teams t JOIN tournaments tn ON tn.id = t.tournament_id
      WHERE t.squad_id = ?
      ORDER BY COALESCE(tn.start_date, tn.created_at) DESC`,
    [squadId],
  );
}

/**
 * Roster-conflict guard: a player may only appear in one team per tournament
 * unless the organizer has explicitly allowed it.
 */
export function conflictingMembers({ tournamentId, squadId }) {
  return all(
    `SELECT DISTINCT u.id, u.name, s2.name AS other_team
       FROM squad_members sm
       JOIN users u ON u.id = sm.user_id
       JOIN squad_members sm2 ON sm2.user_id = sm.user_id AND sm2.status = 'active'
       JOIN squads s2 ON s2.id = sm2.squad_id
       JOIN tournament_registrations reg ON reg.squad_id = sm2.squad_id
      WHERE sm.squad_id = ? AND sm.status = 'active'
        AND reg.tournament_id = ? AND reg.status IN ('pending', 'approved')
        AND sm2.squad_id != ?`,
    [squadId, tournamentId, squadId],
  );
}

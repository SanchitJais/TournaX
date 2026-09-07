/**
 * Tournament registration, approval and check-in.
 *
 * A registration is a squad's application to an event. On approval it
 * materialises the per-tournament `teams` row (and its player roster), which
 * is what every existing feature -- fixtures, results, standings, exports --
 * already operates on. Nothing downstream had to change to support sign-ups.
 */
import { all, get, insert, run, toJson, parseJson, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http.js';
import { recordAudit } from './audit.js';
import { notify } from './notify.js';
import { conflictingMembers, members, squadById } from './squads.js';

const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** Local wall-clock parse for the naive timestamps used throughout. */
const parseLocal = (value) => {
  if (!value) return null;
  const d = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
};

export function registrationCounts(tournamentId) {
  const rows = all(
    'SELECT status, COUNT(*) AS n FROM tournament_registrations WHERE tournament_id = ? GROUP BY status',
    [tournamentId],
  );
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return {
    pending: byStatus.pending || 0,
    approved: byStatus.approved || 0,
    rejected: byStatus.rejected || 0,
    withdrawn: byStatus.withdrawn || 0,
    total: (byStatus.pending || 0) + (byStatus.approved || 0),
  };
}

/** Everything the public registration panel needs to decide what to show. */
export function registrationState(tournament) {
  const counts = registrationCounts(tournament.id);
  const deadline = parseLocal(tournament.registration_deadline);
  const opensAt = parseLocal(tournament.registration_opens_at);
  const now = new Date();

  const notYetOpen = Boolean(opensAt && opensAt > now);
  const past = Boolean(deadline && deadline < now);
  const slots = tournament.slots || tournament.num_teams || 0;
  const full = Boolean(slots && counts.total >= slots);

  let reason = null;
  if (!tournament.registration_open) reason = 'Registration is closed.';
  else if (notYetOpen) reason = `Registration opens ${tournament.registration_opens_at}.`;
  else if (past) reason = 'The registration deadline has passed.';
  else if (full) reason = 'All slots are taken.';

  return {
    open: Boolean(tournament.registration_open) && !notYetOpen && !past && !full,
    reason,
    counts,
    slots,
    deadline: tournament.registration_deadline,
    opens_at: tournament.registration_opens_at,
    approval_mode: tournament.approval_mode || 'auto',
    full,
  };
}

export function myRegistration(tournamentId, userId) {
  if (!userId) return null;
  return get(
    `SELECT r.*, s.name AS squad_name, s.slug AS squad_slug, s.logo_url
       FROM tournament_registrations r
       LEFT JOIN squads s ON s.id = r.squad_id
      WHERE r.tournament_id = ?
        AND r.squad_id IN (SELECT squad_id FROM squad_members WHERE user_id = ? AND status = 'active')
        AND r.status != 'withdrawn'
      ORDER BY r.created_at DESC LIMIT 1`,
    [tournamentId, userId],
  );
}

export function listRegistrations(tournamentId, { status = null } = {}) {
  const where = ['r.tournament_id = ?'];
  const params = [tournamentId];
  if (status) { where.push('r.status = ?'); params.push(status); }
  return all(
    `SELECT r.*, s.name AS squad_name, s.slug AS squad_slug, s.tag, s.logo_url,
            u.name AS submitted_by_name, u.email AS submitted_by_email
       FROM tournament_registrations r
       LEFT JOIN squads s ON s.id = r.squad_id
       LEFT JOIN users u ON u.id = r.submitted_by
      WHERE ${where.join(' AND ')}
      ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at`,
    params,
  ).map((r) => ({ ...r, roster: parseJson(r.roster, []) }));
}

// -------------------------------------------------------------- registering --
export function register({ tournament, squadId, user, notes }) {
  const state = registrationState(tournament);
  if (!state.open) throw badRequest(state.reason || 'Registration is not open.');

  const squad = squadById(squadId);
  if (!squad) throw notFound('Team not found');

  const roster = members(squadId);
  const min = tournament.min_players || 1;
  if (roster.length < min) {
    throw badRequest(`This tournament needs at least ${min} players. Your team has ${roster.length}.`);
  }
  const incomplete = roster.filter((m) => !m.ign);
  if (incomplete.length) {
    throw badRequest(
      `${incomplete.length} player(s) have not completed their profile yet: `
      + `${incomplete.slice(0, 3).map((m) => m.name).join(', ')}.`,
    );
  }

  const existing = get(
    'SELECT * FROM tournament_registrations WHERE tournament_id = ? AND squad_id = ?',
    [tournament.id, squadId],
  );
  if (existing && existing.status !== 'withdrawn' && existing.status !== 'rejected') {
    throw conflict(`${squad.name} is already registered (${existing.status}).`);
  }

  if (!tournament.allow_multi_team) {
    const clashes = conflictingMembers({ tournamentId: tournament.id, squadId });
    if (clashes.length) {
      throw conflict(
        `${clashes.map((c) => c.name).join(', ')} ${clashes.length === 1 ? 'is' : 'are'} already registered `
        + `for this tournament with ${clashes.length === 1 ? `"${clashes[0].other_team}"` : 'another team'}. `
        + 'The organizer can allow multi-team entries in tournament settings.',
      );
    }
  }

  const autoApprove = (tournament.approval_mode || 'auto') === 'auto';
  const snapshot = roster.map((m) => ({
    user_id: m.user_id, name: m.name, ign: m.ign, in_game_id: m.in_game_id, role: m.role,
  }));

  const registrationId = tx(() => {
    if (existing) run('DELETE FROM tournament_registrations WHERE id = ?', [existing.id]);
    const id = insert(
      `INSERT INTO tournament_registrations
         (tournament_id, squad_id, submitted_by, team_name, contact_name, contact_phone,
          contact_email, roster, notes, status, decided_at, decided_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tournament.id, squadId, user.id, squad.name,
        user.name, roster.find((m) => m.role === 'captain')?.phone || null, user.email,
        toJson(snapshot), notes || null,
        autoApprove ? 'approved' : 'pending',
        autoApprove ? nowIso() : null,
        autoApprove ? user.id : null,
      ],
    );
    if (autoApprove) materialiseTeam({ tournament, registrationId: id, squad, roster: snapshot });
    return id;
  });

  recordAudit({
    tournamentId: tournament.id, actor: user, action: 'registration.created',
    entity: 'registration', entityId: registrationId,
    summary: `${squad.name} registered${autoApprove ? ' and was auto-approved' : ' and is awaiting approval'}.`,
  });

  notify({
    tournamentId: tournament.id,
    type: autoApprove ? 'registration.approved' : 'registration.received',
    title: autoApprove ? `${squad.name} joined the tournament` : `New registration: ${squad.name}`,
    body: `${roster.length} players.`,
    severity: autoApprove ? 'success' : 'info',
    link: `/admin/t/${tournament.id}/registrations`,
  });
  notify({
    tournamentId: tournament.id, userId: user.id,
    type: autoApprove ? 'registration.approved' : 'registration.received',
    title: autoApprove
      ? `You are in: ${tournament.name}`
      : `Registration submitted for ${tournament.name}`,
    body: autoApprove ? 'Your team is confirmed.' : 'The organizer will review it shortly.',
    severity: autoApprove ? 'success' : 'info',
    link: `/tournament/${tournament.slug}`,
  });

  return get('SELECT * FROM tournament_registrations WHERE id = ?', [registrationId]);
}

/**
 * Create the per-tournament team row (and its players) from an approved
 * registration. This is the bridge into all the pre-existing machinery.
 */
function materialiseTeam({ tournament, registrationId, squad, roster }) {
  let name = squad.name;
  // teams.name is unique per tournament; fall back rather than fail a sign-up.
  if (get('SELECT id FROM teams WHERE tournament_id = ? AND name = ?', [tournament.id, name])) {
    name = `${squad.name} (${squad.tag || squad.id})`;
  }

  const teamId = insert(
    `INSERT INTO teams (tournament_id, squad_id, registration_id, name, tag, team_code,
                        logo_url, captain_name, captain_contact, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    [
      tournament.id, squad.id, registrationId, name, squad.tag, squad.team_code,
      squad.logo_url,
      roster.find((m) => m.role === 'captain')?.name || null,
      null,
    ],
  );

  roster.forEach((player, i) => {
    insert(
      `INSERT INTO players (team_id, user_id, name, in_game_id, is_captain, is_substitute, order_index)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        teamId, player.user_id || null, player.ign || player.name, player.in_game_id || null,
        player.role === 'captain' ? 1 : 0, player.role === 'substitute' ? 1 : 0, i,
      ],
    );
  });

  run('UPDATE tournament_registrations SET team_id = ? WHERE id = ?', [teamId, registrationId]);
  return teamId;
}

// ------------------------------------------------------------ moderation ---
export function decide({ tournament, registrationId, approve, reason, actor }) {
  const registration = get('SELECT * FROM tournament_registrations WHERE id = ? AND tournament_id = ?',
    [Number(registrationId), tournament.id]);
  if (!registration) throw notFound('Registration not found');
  if (registration.status === 'withdrawn') throw badRequest('That team withdrew its registration.');

  const squad = squadById(registration.squad_id);

  tx(() => {
    run(
      `UPDATE tournament_registrations
          SET status = ?, reject_reason = ?, decided_by = ?, decided_at = datetime('now')
        WHERE id = ?`,
      [approve ? 'approved' : 'rejected', approve ? null : (reason || null), actor?.id ?? null, registration.id],
    );
    if (approve && !registration.team_id) {
      materialiseTeam({
        tournament, registrationId: registration.id, squad,
        roster: parseJson(registration.roster, []),
      });
    }
    // Rejecting an already-approved entry removes its team from the event.
    if (!approve && registration.team_id) {
      run('DELETE FROM teams WHERE id = ?', [registration.team_id]);
      run('UPDATE tournament_registrations SET team_id = NULL WHERE id = ?', [registration.id]);
    }
  });

  recordAudit({
    tournamentId: tournament.id, actor,
    action: approve ? 'registration.approved' : 'registration.rejected',
    entity: 'registration', entityId: registration.id,
    summary: `${approve ? 'Approved' : 'Rejected'} ${registration.team_name}${reason ? `: ${reason}` : ''}.`,
  });

  if (registration.submitted_by) {
    notify({
      tournamentId: tournament.id, userId: registration.submitted_by,
      type: approve ? 'registration.approved' : 'registration.rejected',
      title: approve
        ? `${registration.team_name} is confirmed for ${tournament.name}`
        : `${registration.team_name} was not accepted for ${tournament.name}`,
      body: approve ? 'You are in. Watch for check-in and fixtures.' : (reason || null),
      severity: approve ? 'success' : 'danger',
      link: `/tournament/${tournament.slug}`,
    });
  }

  return get('SELECT * FROM tournament_registrations WHERE id = ?', [registration.id]);
}

export function withdraw({ tournament, registrationId, user }) {
  const registration = get('SELECT * FROM tournament_registrations WHERE id = ? AND tournament_id = ?',
    [Number(registrationId), tournament.id]);
  if (!registration) throw notFound('Registration not found');

  const isOwner = registration.submitted_by === user.id
    || get("SELECT 1 AS ok FROM squad_members WHERE squad_id = ? AND user_id = ? AND role = 'captain' AND status = 'active'",
      [registration.squad_id, user.id]);
  if (!isOwner && user.role !== 'super_admin') throw forbidden('Only the team captain can withdraw.');

  tx(() => {
    run("UPDATE tournament_registrations SET status = 'withdrawn' WHERE id = ?", [registration.id]);
    if (registration.team_id) {
      run('DELETE FROM teams WHERE id = ?', [registration.team_id]);
      run('UPDATE tournament_registrations SET team_id = NULL WHERE id = ?', [registration.id]);
    }
  });

  recordAudit({
    tournamentId: tournament.id, actor: user, action: 'registration.withdrawn',
    entity: 'registration', entityId: registration.id,
    summary: `${registration.team_name} withdrew from the tournament.`,
  });
  return { ok: true };
}

// -------------------------------------------------------------- check-in ---
/** Check-in opens N minutes before the first match and closes M minutes before. */
export function checkInWindow(tournament) {
  if (!tournament.check_in_enabled) return { enabled: false, open: false };

  const first = get(
    `SELECT MIN(scheduled_at) AS at FROM matches WHERE tournament_id = ? AND status != 'cancelled'`,
    [tournament.id],
  )?.at || tournament.start_date;

  const start = parseLocal(first);
  if (!start) return { enabled: true, open: false, reason: 'No matches scheduled yet.' };

  const opensAt = new Date(start.getTime() - (tournament.check_in_minutes_before || 60) * 60000);
  const closesAt = new Date(start.getTime() - (tournament.check_in_close_minutes || 15) * 60000);
  const now = new Date();

  return {
    enabled: true,
    open: now >= opensAt && now <= closesAt,
    opens_at: fmt(opensAt),
    closes_at: fmt(closesAt),
    first_match: first,
    reason: now < opensAt ? `Check-in opens at ${fmt(opensAt)}.`
      : now > closesAt ? 'Check-in has closed.' : null,
  };
}

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function checkIn({ tournament, registrationId, user, force = false }) {
  const registration = get('SELECT * FROM tournament_registrations WHERE id = ? AND tournament_id = ?',
    [Number(registrationId), tournament.id]);
  if (!registration) throw notFound('Registration not found');
  if (registration.status !== 'approved') throw badRequest('Only approved teams can check in.');

  if (!force) {
    const window = checkInWindow(tournament);
    if (!window.enabled) throw badRequest('Check-in is not enabled for this tournament.');
    if (!window.open) throw badRequest(window.reason || 'Check-in is not open.');
  }

  run("UPDATE tournament_registrations SET checked_in_at = datetime('now') WHERE id = ?", [registration.id]);
  if (registration.team_id) {
    run("UPDATE teams SET checked_in_at = datetime('now') WHERE id = ?", [registration.team_id]);
  }
  recordAudit({
    tournamentId: tournament.id, actor: user, action: 'registration.checked_in',
    entity: 'registration', entityId: registration.id,
    summary: `${registration.team_name} checked in${force ? ' (by an organizer)' : ''}.`,
  });
  return get('SELECT * FROM tournament_registrations WHERE id = ?', [registration.id]);
}

/** Teams that never checked in -- the organizer's no-show list. */
export function noShows(tournamentId) {
  return all(
    `SELECT r.*, s.name AS squad_name FROM tournament_registrations r
       LEFT JOIN squads s ON s.id = r.squad_id
      WHERE r.tournament_id = ? AND r.status = 'approved' AND r.checked_in_at IS NULL
      ORDER BY r.team_name`,
    [tournamentId],
  );
}

/** Tournaments a user is involved in, for their personal dashboard. */
export function tournamentsForUser(userId) {
  return all(
    `SELECT DISTINCT tn.id, tn.slug, tn.name, tn.game, tn.status, tn.start_date, tn.end_date,
            tn.logo_url, tn.banner_url, tn.prize_pool,
            r.status AS registration_status, r.checked_in_at, r.id AS registration_id,
            s.name AS squad_name, s.slug AS squad_slug, r.team_id
       FROM tournament_registrations r
       JOIN tournaments tn ON tn.id = r.tournament_id
       LEFT JOIN squads s ON s.id = r.squad_id
      WHERE r.squad_id IN (SELECT squad_id FROM squad_members WHERE user_id = ? AND status = 'active')
        AND r.status != 'withdrawn'
      ORDER BY COALESCE(tn.start_date, tn.created_at) DESC`,
    [userId],
  );
}

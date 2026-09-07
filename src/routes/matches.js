/** Fixture generation, the Match Center, and result entry. */
import { all, get, insert, parseJson, run, tx, updateRow } from '../db.js';
import { can, requireAbility } from '../auth.js';
import { MATCH_STATUSES } from '../config.js';
import { badRequest, notFound } from '../lib/http.js';
import { recordAudit } from '../services/audit.js';
import { notify } from '../services/notify.js';
import { computeMatchResults } from '../services/scoring.js';
import { generateFixtures } from '../services/fixtures.js';
import { generateStageFixtures, renumberMatches, stageTeams } from '../services/scheduler.js';
import { loadSettings, loadTournament } from './tournaments.js';

/**
 * Timestamps entered by organizers are naive local time ("2026-10-01 19:00"),
 * matching what the fixture scheduler writes and what a datetime-local input
 * produces. Normalise the separator so both forms compare correctly.
 */
export function normaliseStamp(value) {
  if (value === undefined) return undefined;
  if (!value) return null;
  return String(value).replace('T', ' ').slice(0, 19);
}

/**
 * Room ID and password visibility.
 *
 * Staff always see them. Everyone else is subject to the match's reveal
 * policy -- immediately, a set number of minutes before the match, or manual
 * (an explicit reveal time). `participant` gates the final release: once due,
 * the details go to the teams playing the match, not to the open web.
 */
export function visibleCredentials(match, { privileged = false, participant = false } = {}) {
  const hidden = { room_id: null, room_password: null, revealed: false };
  if (privileged) {
    return {
      room_id: match.room_id, room_password: match.room_password,
      revealed: true, policy: match.reveal_policy || 'manual',
    };
  }
  if (!match.room_id && !match.room_password) return { ...hidden, reason: 'not_set' };

  const policy = match.reveal_policy || 'manual';
  const now = new Date();
  let dueAt = null;

  if (policy === 'immediate') {
    dueAt = now;
  } else if (match.credentials_reveal_at) {
    dueAt = new Date(String(match.credentials_reveal_at).replace(' ', 'T'));
  } else if (policy === 'minutes' && match.scheduled_at) {
    const start = new Date(String(match.scheduled_at).replace(' ', 'T'));
    dueAt = new Date(start.getTime() - (match.reveal_minutes_before ?? 15) * 60000);
  }

  if (!dueAt || dueAt > now) {
    return {
      ...hidden, policy,
      reveal_at: dueAt ? formatLocal(dueAt) : null,
      reason: dueAt ? 'scheduled' : 'manual',
    };
  }
  if (!participant) return { ...hidden, policy, restricted: true, reason: 'participants_only' };

  return { room_id: match.room_id, room_password: match.room_password, revealed: true, policy };
}

const pad2 = (n) => String(n).padStart(2, '0');
const formatLocal = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** Team ids the signed-in user actually plays for in this tournament. */
export function participantTeamIds(user, tournamentId) {
  if (!user) return new Set();
  return new Set(all(
    `SELECT t.id FROM teams t
       JOIN squad_members sm ON sm.squad_id = t.squad_id
      WHERE t.tournament_id = ? AND sm.user_id = ? AND sm.status = 'active'`,
    [tournamentId, user.id],
  ).map((r) => r.id));
}

export function matchDetail(id, { privileged = false, participantTeams = null } = {}) {
  const match = get(
    `SELECT m.*, s.name AS stage_name, s.kind AS stage_kind, r.name AS round_name, g.name AS group_name
       FROM matches m
       JOIN stages s ON s.id = m.stage_id
       LEFT JOIN rounds r ON r.id = m.round_id
       LEFT JOIN groups g ON g.id = m.group_id
      WHERE m.id = ?`,
    [id],
  );
  if (!match) return null;

  const participants = all(
    `SELECT mp.team_id, mp.slot, t.name, t.tag, t.logo_url, t.team_code
       FROM match_participants mp JOIN teams t ON t.id = mp.team_id
      WHERE mp.match_id = ? ORDER BY mp.slot`,
    [id],
  );
  const results = all(
    `SELECT r.*, t.name AS team_name, t.tag, t.logo_url
       FROM match_results r JOIN teams t ON t.id = r.team_id
      WHERE r.match_id = ? ORDER BY COALESCE(r.placement, 999), r.total_points DESC`,
    [id],
  );

  const participant = Boolean(participantTeams && participants.some((p) => participantTeams.has(p.team_id)));
  const { room_id, room_password, ...reveal } = visibleCredentials(match, { privileged, participant });
  return {
    ...match, room_id, room_password, credentials: { ...reveal, participant },
    participants,
    results,
  };
}

export default function register(router) {
  // ----------------------------------------------------------- fixtures ------
  /** Draw a schedule without saving it, so the organizer can look first. */
  router.post('/api/stages/:id/fixtures/preview', (ctx) => {
    const stage = get('SELECT * FROM stages WHERE id = ?', [Number(ctx.params.id)]);
    if (!stage) throw notFound('Stage not found');
    requireAbility(ctx, 'fixtures:write', stage.tournament_id);

    const tournament = loadTournament(stage.tournament_id);
    const settings = loadSettings(tournament.id);
    const teams = stageTeams(tournament.id, stage);

    const options = {
      ...parseJson(settings.fixture_options, {}),
      ...(ctx.body.options || {}),
    };
    const plan = generateFixtures({
      teams,
      formatType: ctx.body.format_type || tournament.format_type,
      numGroups: num(ctx.body.num_groups, stage.num_groups),
      numRounds: num(ctx.body.num_rounds, stage.num_rounds),
      matchesPerRound: num(ctx.body.matches_per_round, stage.matches_per_round),
      teamsPerMatch: num(ctx.body.teams_per_match, stage.teams_per_match),
      options,
      schedule: {
        ...parseJson(settings.schedule_options, {}),
        ...(ctx.body.schedule || {}),
        startDate: ctx.body.start_date || tournament.start_date,
      },
    });

    const nameOf = new Map(teams.map((t) => [t.id, t.name]));
    return {
      seed: plan.seed,
      warnings: plan.warnings,
      groups: plan.groups.map((g) => ({ ...g, teams: g.teamIds.map((id) => nameOf.get(id)) })),
      matches: plan.matches.map((m) => ({
        match_no: m.match_no,
        label: m.label,
        round: plan.rounds[m.roundIndex]?.name,
        group: plan.groups[m.groupIndex]?.name,
        scheduled_at: m.scheduled_at,
        teams: m.teamIds.map((id) => nameOf.get(id)),
      })),
    };
  });

  /** "Generate Fixtures Automatically" -- draws and commits. */
  router.post('/api/stages/:id/fixtures/generate', (ctx) => {
    const stage = get('SELECT * FROM stages WHERE id = ?', [Number(ctx.params.id)]);
    if (!stage) throw notFound('Stage not found');
    requireAbility(ctx, 'fixtures:write', stage.tournament_id);

    const tournament = loadTournament(stage.tournament_id);
    const teams = stageTeams(tournament.id, stage);
    if (teams.length < 2) throw badRequest('Add at least two teams before generating fixtures.');

    // Stage shape can be adjusted in the same action as the draw.
    updateRow('stages', stage.id, {
      num_groups: ctx.body.num_groups === undefined ? undefined : num(ctx.body.num_groups, stage.num_groups),
      num_rounds: ctx.body.num_rounds === undefined ? undefined : num(ctx.body.num_rounds, stage.num_rounds),
      matches_per_round: ctx.body.matches_per_round === undefined ? undefined : num(ctx.body.matches_per_round, stage.matches_per_round),
      teams_per_match: ctx.body.teams_per_match === undefined ? undefined : num(ctx.body.teams_per_match, stage.teams_per_match),
    }, ['num_groups', 'num_rounds', 'matches_per_round', 'teams_per_match']);

    const result = generateStageFixtures({
      tournament,
      settings: loadSettings(tournament.id),
      stage: get('SELECT * FROM stages WHERE id = ?', [stage.id]),
      teams,
      overrides: { ...(ctx.body.options || {}), startDate: ctx.body.start_date || null },
      actor: ctx.user,
    });

    return {
      matches: result.matches,
      warnings: result.warnings,
      seed: result.seed,
      fixtures: listMatches(tournament.id, { privileged: true }),
    };
  });

  // ------------------------------------------------------------- matches -----
  router.get('/api/tournaments/:id/matches', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    const privileged = can(ctx.user, 'matches:write', tournamentId) || can(ctx.user, 'results:write', tournamentId);
    return {
      matches: listMatches(tournamentId, {
        privileged,
        participantTeams: participantTeamIds(ctx.user, tournamentId),
        stageId: ctx.query.stage ? Number(ctx.query.stage) : null,
        status: ctx.query.status || null,
        search: ctx.query.search || '',
      }),
    };
  });

  router.get('/api/matches/:id', (ctx) => {
    const id = Number(ctx.params.id);
    const base = get('SELECT tournament_id FROM matches WHERE id = ?', [id]);
    if (!base) throw notFound('Match not found');
    const privileged = can(ctx.user, 'matches:write', base.tournament_id) || can(ctx.user, 'results:write', base.tournament_id);
    return { match: matchDetail(id, { privileged, participantTeams: participantTeamIds(ctx.user, base.tournament_id) }) };
  });

  router.post('/api/tournaments/:id/matches', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'matches:write', tournamentId);
    const stageId = Number(ctx.body.stage_id)
      || get('SELECT id FROM stages WHERE tournament_id = ? ORDER BY order_index LIMIT 1', [tournamentId])?.id;
    if (!stageId) throw badRequest('Create a stage first.');

    const nextNo = (get('SELECT MAX(match_no) AS m FROM matches WHERE tournament_id = ?', [tournamentId]).m || 0) + 1;
    const id = tx(() => {
      const matchId = insert(
        `INSERT INTO matches (tournament_id, stage_id, round_id, group_id, match_no, label, map, scheduled_at, room_id, room_password, credentials_reveal_at, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tournamentId, stageId,
          ctx.body.round_id ? Number(ctx.body.round_id) : null,
          ctx.body.group_id ? Number(ctx.body.group_id) : null,
          nextNo, ctx.body.label || `Match ${nextNo}`, ctx.body.map || null,
          ctx.body.scheduled_at || null, ctx.body.room_id || null, ctx.body.room_password || null,
          ctx.body.credentials_reveal_at || null,
          MATCH_STATUSES.includes(ctx.body.status) ? ctx.body.status : 'upcoming',
          ctx.body.notes || null,
        ],
      );
      (ctx.body.team_ids || []).forEach((teamId, slot) => {
        insert('INSERT INTO match_participants (match_id, team_id, slot) VALUES (?, ?, ?)', [matchId, Number(teamId), slot]);
      });
      renumberMatches(tournamentId);
      return matchId;
    });

    recordAudit({
      tournamentId, actor: ctx.user, action: 'match.created', entity: 'match', entityId: id,
      summary: `Created ${ctx.body.label || `match ${nextNo}`}.`,
    });
    return { __status: 201, match: matchDetail(id, { privileged: true }) };
  });

  router.patch('/api/matches/:id', (ctx) => {
    const id = Number(ctx.params.id);
    const before = get('SELECT * FROM matches WHERE id = ?', [id]);
    if (!before) throw notFound('Match not found');

    // Scorekeepers may move a match's status but not rewrite its schedule.
    const statusOnly = !can(ctx.user, 'matches:write', before.tournament_id);
    if (statusOnly) requireAbility(ctx, 'matches:status', before.tournament_id);
    else requireAbility(ctx, 'matches:write', before.tournament_id);

    const allowed = statusOnly
      ? ['status']
      : ['label', 'map', 'scheduled_at', 'room_id', 'room_password', 'credentials_reveal_at',
        'reveal_policy', 'reveal_minutes_before', 'status', 'notes', 'group_id', 'round_id'];

    if (ctx.body.status && !MATCH_STATUSES.includes(ctx.body.status)) {
      throw badRequest(`Status must be one of: ${MATCH_STATUSES.join(', ')}.`);
    }
    updateRow('matches', id, {
      ...ctx.body,
      scheduled_at: normaliseStamp(ctx.body.scheduled_at),
      credentials_reveal_at: normaliseStamp(ctx.body.credentials_reveal_at),
    }, allowed);

    if (Array.isArray(ctx.body.team_ids) && !statusOnly) {
      tx(() => {
        run('DELETE FROM match_participants WHERE match_id = ?', [id]);
        ctx.body.team_ids.forEach((teamId, slot) => {
          insert('INSERT INTO match_participants (match_id, team_id, slot) VALUES (?, ?, ?)', [id, Number(teamId), slot]);
        });
      });
    }

    const after = get('SELECT * FROM matches WHERE id = ?', [id]);
    announceMatchChange(before, after, ctx.user);
    recordAudit({
      tournamentId: before.tournament_id, actor: ctx.user, action: 'match.updated', entity: 'match', entityId: id,
      summary: matchChangeSummary(before, after), before, after,
    });
    return { match: matchDetail(id, { privileged: true }) };
  });

  router.delete('/api/matches/:id', (ctx) => {
    const id = Number(ctx.params.id);
    const match = get('SELECT * FROM matches WHERE id = ?', [id]);
    if (!match) throw notFound('Match not found');
    requireAbility(ctx, 'matches:write', match.tournament_id);
    run('DELETE FROM matches WHERE id = ?', [id]);
    renumberMatches(match.tournament_id);
    recordAudit({
      tournamentId: match.tournament_id, actor: ctx.user, action: 'match.deleted', entity: 'match', entityId: id,
      summary: `Deleted ${match.label || `match ${match.match_no}`}.`, before: match,
    });
    return { ok: true };
  });

  /** Publish room credentials for several matches at once. */
  router.post('/api/tournaments/:id/matches/credentials', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'matches:write', tournamentId);
    const entries = ctx.body.entries || [];
    let updated = 0;
    tx(() => {
      for (const entry of entries) {
        const changed = updateRow('matches', Number(entry.match_id), {
          room_id: entry.room_id, room_password: entry.room_password,
          credentials_reveal_at: normaliseStamp(entry.credentials_reveal_at),
          reveal_policy: entry.reveal_policy,
          reveal_minutes_before: entry.reveal_minutes_before,
        }, ['room_id', 'room_password', 'credentials_reveal_at', 'reveal_policy', 'reveal_minutes_before']);
        if (changed) updated++;
      }
    });
    if (updated) {
      notify({
        tournamentId, type: 'match.credentials',
        title: 'Room details released',
        body: `Room ID and password published for ${updated} match(es).`,
        severity: 'success',
      });
      recordAudit({
        tournamentId, actor: ctx.user, action: 'match.credentials', entity: 'tournament', entityId: tournamentId,
        summary: `Published room credentials for ${updated} match(es).`,
      });
    }
    return { updated };
  });

  // ------------------------------------------------------------- results -----
  router.get('/api/matches/:id/results', (ctx) => {
    const id = Number(ctx.params.id);
    const match = get('SELECT * FROM matches WHERE id = ?', [id]);
    if (!match) throw notFound('Match not found');
    return {
      match: matchDetail(id, { privileged: can(ctx.user, 'results:write', match.tournament_id) }),
      scoring: parseJson(loadSettings(match.tournament_id).scoring, {}),
    };
  });

  /**
   * Save a match result. Points are always recomputed here -- the organizer
   * supplies placements, kills, bonuses and penalties only.
   */
  router.put('/api/matches/:id/results', (ctx) => {
    const id = Number(ctx.params.id);
    const match = get('SELECT * FROM matches WHERE id = ?', [id]);
    if (!match) throw notFound('Match not found');
    requireAbility(ctx, 'results:write', match.tournament_id);

    const participantIds = new Set(
      all('SELECT team_id FROM match_participants WHERE match_id = ?', [id]).map((r) => r.team_id),
    );
    const scoring = parseJson(loadSettings(match.tournament_id).scoring, {});
    const { rows, errors } = computeMatchResults(ctx.body.entries || [], scoring, {
      participantIds: participantIds.size ? participantIds : null,
    });
    if (errors.length) throw badRequest(errors[0], { errors });

    const before = all('SELECT * FROM match_results WHERE match_id = ?', [id]);
    const status = MATCH_STATUSES.includes(ctx.body.status) ? ctx.body.status : 'completed';

    tx(() => {
      run('DELETE FROM match_results WHERE match_id = ?', [id]);
      for (const row of rows) {
        insert(
          `INSERT INTO match_results
             (match_id, team_id, placement, kills, placement_points, kill_points, bonus_points,
              penalty_points, total_points, is_win, notes, recorded_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, row.team_id, row.placement, row.kills, row.placement_points, row.kill_points,
            row.bonus_points, row.penalty_points, row.total_points, row.is_win, row.notes,
            ctx.user?.id ?? null,
          ],
        );
      }
      run("UPDATE matches SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, id]);
    });

    const isEdit = before.length > 0;
    recordAudit({
      tournamentId: match.tournament_id, actor: ctx.user,
      action: isEdit ? 'result.updated' : 'result.created',
      entity: 'match', entityId: id,
      summary: `${isEdit ? 'Edited' : 'Entered'} results for ${match.label || `match ${match.match_no}`} (${rows.length} teams).`,
      before: isEdit ? summariseResults(before) : undefined,
      after: summariseResults(rows),
    });

    if (status === 'completed') {
      const winner = rows.find((r) => r.placement === 1);
      const winnerName = winner ? get('SELECT name FROM teams WHERE id = ?', [winner.team_id])?.name : null;
      notify({
        tournamentId: match.tournament_id,
        type: isEdit ? 'results.published' : 'match.completed',
        title: `${match.label || `Match ${match.match_no}`} ${isEdit ? 'result updated' : 'completed'}`,
        body: winnerName ? `${winnerName} takes the win with ${winner.kills} kills.` : `${rows.length} results recorded.`,
        severity: 'success',
        link: `/t/match/${match.id}`,
      });
    }

    return { match: matchDetail(id, { privileged: true }) };
  });

  router.delete('/api/matches/:id/results', (ctx) => {
    const id = Number(ctx.params.id);
    const match = get('SELECT * FROM matches WHERE id = ?', [id]);
    if (!match) throw notFound('Match not found');
    requireAbility(ctx, 'results:write', match.tournament_id);
    const before = all('SELECT * FROM match_results WHERE match_id = ?', [id]);
    tx(() => {
      run('DELETE FROM match_results WHERE match_id = ?', [id]);
      run("UPDATE matches SET status = 'upcoming' WHERE id = ?", [id]);
    });
    recordAudit({
      tournamentId: match.tournament_id, actor: ctx.user, action: 'result.cleared', entity: 'match', entityId: id,
      summary: `Cleared results for ${match.label || `match ${match.match_no}`}.`, before: summariseResults(before),
    });
    return { match: matchDetail(id, { privileged: true }) };
  });
}

// --------------------------------------------------------------------- utils --
export function listMatches(tournamentId, {
  privileged = false, stageId = null, status = null, search = '', participantTeams = null,
} = {}) {
  const where = ['m.tournament_id = ?'];
  const params = [tournamentId];
  if (stageId) { where.push('m.stage_id = ?'); params.push(stageId); }
  if (status) { where.push('m.status = ?'); params.push(status); }
  if (search) { where.push('(m.label LIKE ? OR m.map LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }

  const matches = all(
    `SELECT m.*, s.name AS stage_name, r.name AS round_name, g.name AS group_name
       FROM matches m
       JOIN stages s ON s.id = m.stage_id
       LEFT JOIN rounds r ON r.id = m.round_id
       LEFT JOIN groups g ON g.id = m.group_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.match_no`,
    params,
  );
  if (!matches.length) return [];

  const ids = matches.map((m) => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const participants = all(
    `SELECT mp.match_id, mp.team_id, mp.slot, t.name, t.tag, t.logo_url
       FROM match_participants mp JOIN teams t ON t.id = mp.team_id
      WHERE mp.match_id IN (${placeholders}) ORDER BY mp.slot`,
    ids,
  );
  const results = all(
    `SELECT match_id, team_id, placement, kills, total_points FROM match_results
      WHERE match_id IN (${placeholders})`,
    ids,
  );

  const byMatch = new Map(ids.map((id) => [id, []]));
  for (const p of participants) byMatch.get(p.match_id)?.push(p);
  const resultsByMatch = new Map(ids.map((id) => [id, []]));
  for (const r of results) resultsByMatch.get(r.match_id)?.push(r);

  return matches.map((m) => {
    const lineup = byMatch.get(m.id) || [];
    const participant = Boolean(participantTeams && lineup.some((p) => participantTeams.has(p.team_id)));
    const { room_id, room_password, ...reveal } = visibleCredentials(m, { privileged, participant });
    return {
      ...m, room_id, room_password, credentials: { ...reveal, participant },
      teams: lineup,
      result_count: (resultsByMatch.get(m.id) || []).length,
      winner: (resultsByMatch.get(m.id) || []).find((r) => r.placement === 1) || null,
    };
  });
}

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
};

const summariseResults = (rows) =>
  rows.map((r) => ({ team_id: r.team_id, placement: r.placement, kills: r.kills, total: r.total_points }));

function matchChangeSummary(before, after) {
  const bits = [];
  if (before.status !== after.status) bits.push(`status ${before.status} -> ${after.status}`);
  if (before.scheduled_at !== after.scheduled_at) bits.push(`time -> ${after.scheduled_at || 'unset'}`);
  if (before.room_id !== after.room_id || before.room_password !== after.room_password) bits.push('room credentials updated');
  if (before.map !== after.map) bits.push(`map -> ${after.map || 'unset'}`);
  const label = after.label || `Match ${after.match_no}`;
  return bits.length ? `${label}: ${bits.join(', ')}.` : `Updated ${label}.`;
}

function announceMatchChange(before, after, actor) {
  if (before.status === after.status) return;
  const label = after.label || `Match ${after.match_no}`;
  if (after.status === 'live') {
    notify({
      tournamentId: after.tournament_id, type: 'match.started',
      title: `${label} is live`, severity: 'warning', link: `/t/match/${after.id}`,
    });
  } else if (after.status === 'cancelled') {
    notify({
      tournamentId: after.tournament_id, type: 'stage.changed',
      title: `${label} was cancelled`, severity: 'danger',
      body: actor?.name ? `Cancelled by ${actor.name}.` : null,
    });
  }
}

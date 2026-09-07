/**
 * Penalties, disqualifications and suspensions.
 *
 * Match-level deductions already live on match_results.penalty_points. These
 * are the standalone sanctions an organizer applies outside a single match
 * (late start, misconduct, roster breach, DQ). They are subtracted from the
 * derived standings rather than written into any stored total, so revoking a
 * penalty puts the table straight back.
 */
import { all, get, insert, run, tx } from '../db.js';
import { badRequest, notFound } from '../lib/http.js';
import { recordAudit } from './audit.js';
import { notify } from './notify.js';

export const PENALTY_KINDS = {
  points: 'Points deduction',
  disqualification: 'Disqualify team',
  suspension: 'Suspend player',
  warning: 'Formal warning',
};

export function listPenalties(tournamentId, { includeRevoked = false } = {}) {
  return all(
    `SELECT p.*, t.name AS team_name, t.tag, pl.name AS player_name, u.name AS created_by_name,
            m.match_no
       FROM penalties p
       LEFT JOIN teams t ON t.id = p.team_id
       LEFT JOIN players pl ON pl.id = p.player_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN matches m ON m.id = p.match_id
      WHERE p.tournament_id = ?${includeRevoked ? '' : ' AND p.active = 1'}
      ORDER BY p.created_at DESC`,
    [tournamentId],
  );
}

/** teamId -> total active points deducted. Consumed by the leaderboard. */
export function penaltyTotals(tournamentId) {
  const rows = all(
    `SELECT team_id, COALESCE(SUM(points), 0) AS points
       FROM penalties
      WHERE tournament_id = ? AND active = 1 AND kind = 'points' AND team_id IS NOT NULL
      GROUP BY team_id`,
    [tournamentId],
  );
  return new Map(rows.map((r) => [r.team_id, r.points]));
}

export const disqualifiedTeamIds = (tournamentId) => new Set(
  all(
    "SELECT id FROM teams WHERE tournament_id = ? AND disqualified = 1",
    [tournamentId],
  ).map((r) => r.id),
);

export function applyPenalty({ tournament, teamId, matchId, playerId, kind, points, reason, actor }) {
  if (!PENALTY_KINDS[kind]) throw badRequest('Unknown penalty type.');
  if (!reason || String(reason).trim().length < 3) throw badRequest('Give a reason -- it is shown in the audit trail.');

  const team = teamId ? get('SELECT * FROM teams WHERE id = ? AND tournament_id = ?', [Number(teamId), tournament.id]) : null;
  if (teamId && !team) throw notFound('Team not found in this tournament');

  const value = kind === 'points' ? Math.abs(Number(points) || 0) : 0;
  if (kind === 'points' && value === 0) throw badRequest('Enter how many points to deduct.');

  const id = tx(() => {
    const penaltyId = insert(
      `INSERT INTO penalties (tournament_id, team_id, match_id, player_id, kind, points, reason, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [tournament.id, team?.id ?? null, matchId ? Number(matchId) : null,
        playerId ? Number(playerId) : null, kind, value, String(reason).trim(), actor?.id ?? null],
    );
    if (kind === 'disqualification' && team) {
      run("UPDATE teams SET disqualified = 1, status = 'eliminated' WHERE id = ?", [team.id]);
    }
    return penaltyId;
  });

  const label = team ? team.name : 'the tournament';
  recordAudit({
    tournamentId: tournament.id, actor, action: 'penalty.applied', entity: 'team', entityId: team?.id ?? null,
    summary: `${PENALTY_KINDS[kind]} for ${label}${value ? ` (-${value} pts)` : ''}: ${reason}`,
    after: { kind, points: value, reason },
  });
  notify({
    tournamentId: tournament.id, type: 'penalty.applied',
    title: kind === 'disqualification' ? `${label} disqualified` : `Penalty applied to ${label}`,
    body: `${PENALTY_KINDS[kind]}${value ? ` -- ${value} points` : ''}. ${reason}`,
    severity: 'danger',
  });

  return get('SELECT * FROM penalties WHERE id = ?', [id]);
}

export function revokePenalty({ tournament, penaltyId, actor }) {
  const penalty = get('SELECT * FROM penalties WHERE id = ? AND tournament_id = ?', [Number(penaltyId), tournament.id]);
  if (!penalty) throw notFound('Penalty not found');

  tx(() => {
    run('UPDATE penalties SET active = 0 WHERE id = ?', [penalty.id]);
    if (penalty.kind === 'disqualification' && penalty.team_id) {
      const others = get(
        "SELECT COUNT(*) AS n FROM penalties WHERE team_id = ? AND kind = 'disqualification' AND active = 1",
        [penalty.team_id],
      ).n;
      if (!others) run("UPDATE teams SET disqualified = 0, status = 'active' WHERE id = ?", [penalty.team_id]);
    }
  });

  recordAudit({
    tournamentId: tournament.id, actor, action: 'penalty.revoked', entity: 'team', entityId: penalty.team_id,
    summary: `Revoked ${PENALTY_KINDS[penalty.kind]}: ${penalty.reason}`,
    before: { kind: penalty.kind, points: penalty.points },
  });
  return { ok: true };
}

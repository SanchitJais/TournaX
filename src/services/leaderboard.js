/**
 * Standings are always derived, never stored.
 *
 * Every number here is aggregated from match_results at read time, so editing
 * a single result silently and correctly rewrites the whole table -- there is
 * no cached ranking that can drift out of step with the raw scores.
 */
import { all, parseJson } from '../db.js';
import { DEFAULT_TIEBREAKERS } from '../config.js';
import { round2 } from './scoring.js';
import { penaltyTotals } from './penalties.js';

/** Higher is better unless listed here. */
const ASCENDING = new Set(['best_placement', 'fewest_matches', 'avg_placement', 'team_name']);

const METRIC = {
  total_points: (s) => s.total_points,
  placement_points: (s) => s.placement_points,
  total_kills: (s) => s.total_kills,
  wins: (s) => s.wins,
  best_placement: (s) => (s.best_placement === null ? Infinity : s.best_placement),
  avg_placement: (s) => (s.avg_placement === null ? Infinity : s.avg_placement),
  avg_points: (s) => s.avg_points,
  avg_kills: (s) => s.avg_kills,
  last_match_points: (s) => s.last_match_points,
  fewest_matches: (s) => s.matches_played,
  team_name: (s) => s.team_name.toLowerCase(),
};

/**
 * Build a comparator from an ordered list of tiebreaker keys. Unknown keys are
 * skipped so a stale saved config cannot break the table.
 */
export function buildComparator(tiebreakers) {
  const keys = (tiebreakers?.length ? tiebreakers : DEFAULT_TIEBREAKERS).filter((k) => METRIC[k]);
  const ordered = keys.includes('total_points') ? keys : ['total_points', ...keys];

  return (a, b) => {
    for (const key of ordered) {
      const get = METRIC[key];
      const av = get(a);
      const bv = get(b);
      if (av === bv) continue;
      if (typeof av === 'string' || typeof bv === 'string') {
        return ASCENDING.has(key) ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
      }
      return ASCENDING.has(key) ? av - bv : bv - av;
    }
    // Stable, human-sensible last resort.
    return a.team_name.localeCompare(b.team_name);
  };
}

/**
 * Aggregate results into standings.
 *
 * @param {object} opts
 * @param {number} opts.tournamentId
 * @param {number} [opts.stageId]        restrict to one stage
 * @param {number} [opts.groupId]        restrict to one group
 * @param {number[]} [opts.teamIds]      restrict to specific teams
 * @param {number} [opts.beforeMatchNo]  ignore matches numbered >= this (used
 *                                       to work out rank movement)
 * @param {string[]} [opts.tiebreakers]
 */
export function computeStandings(opts) {
  const {
    tournamentId, stageId = null, groupId = null, teamIds = null,
    beforeMatchNo = null, tiebreakers = DEFAULT_TIEBREAKERS,
  } = opts;

  const where = ['t.tournament_id = ?'];
  const params = [tournamentId];
  if (groupId) { where.push('t.group_id = ?'); params.push(groupId); }
  if (teamIds?.length) {
    where.push(`t.id IN (${teamIds.map(() => '?').join(',')})`);
    params.push(...teamIds);
  }

  const teams = all(
    `SELECT t.id, t.name, t.tag, t.logo_url, t.status, t.seed, t.group_id, t.squad_id,
            t.disqualified, t.checked_in_at, g.name AS group_name
       FROM teams t
       LEFT JOIN groups g ON g.id = t.group_id
      WHERE ${where.join(' AND ')}
      ORDER BY t.name`,
    params,
  );

  // Standalone sanctions (not tied to a single match) come off the total here
  // rather than being written into any stored figure, so revoking one restores
  // the table immediately.
  const sanctions = penaltyTotals(tournamentId);

  // Only completed matches count towards standings.
  const resultWhere = ['m.tournament_id = ?', "m.status = 'completed'"];
  const resultParams = [tournamentId];
  if (stageId) { resultWhere.push('m.stage_id = ?'); resultParams.push(stageId); }
  if (beforeMatchNo !== null) { resultWhere.push('m.match_no < ?'); resultParams.push(beforeMatchNo); }

  const results = all(
    `SELECT r.*, m.match_no, m.stage_id, m.group_id AS match_group_id
       FROM match_results r
       JOIN matches m ON m.id = r.match_id
      WHERE ${resultWhere.join(' AND ')}
      ORDER BY m.match_no`,
    resultParams,
  );

  const byTeam = new Map();
  for (const team of teams) {
    byTeam.set(team.id, {
      team_id: team.id,
      team_name: team.name,
      tag: team.tag,
      logo_url: team.logo_url,
      status: team.status,
      seed: team.seed,
      group_id: team.group_id,
      group_name: team.group_name,
      squad_id: team.squad_id,
      disqualified: team.disqualified ? 1 : 0,
      checked_in: team.checked_in_at ? 1 : 0,
      sanction_points: sanctions.get(team.id) || 0,
      matches_played: 0,
      wins: 0,
      placement_points: 0,
      kill_points: 0,
      bonus_points: 0,
      penalty_points: 0,
      total_points: 0,
      total_kills: 0,
      best_placement: null,
      placements: [],
      last_match_points: 0,
      last_match_no: 0,
    });
  }

  for (const row of results) {
    const standing = byTeam.get(row.team_id);
    if (!standing) continue;   // result for a team outside this slice
    standing.matches_played += 1;
    standing.wins += row.is_win ? 1 : 0;
    standing.placement_points += row.placement_points;
    standing.kill_points += row.kill_points;
    standing.bonus_points += row.bonus_points;
    standing.penalty_points += row.penalty_points;
    standing.total_points += row.total_points;
    standing.total_kills += row.kills;
    if (row.placement != null) {
      standing.placements.push(row.placement);
      if (standing.best_placement === null || row.placement < standing.best_placement) {
        standing.best_placement = row.placement;
      }
    }
    if (row.match_no >= standing.last_match_no) {
      standing.last_match_no = row.match_no;
      standing.last_match_points = row.total_points;
    }
  }

  const standings = [...byTeam.values()].map((s) => {
    const played = s.matches_played || 0;
    // Match penalties are already inside total_points; sanctions are not.
    const total = s.total_points - s.sanction_points;
    return {
      ...s,
      placement_points: round2(s.placement_points),
      kill_points: round2(s.kill_points),
      bonus_points: round2(s.bonus_points),
      penalty_points: round2(s.penalty_points + s.sanction_points),
      total_points: round2(total),
      avg_points: played ? round2(total / played) : 0,
      avg_kills: played ? round2(s.total_kills / played) : 0,
      avg_placement: s.placements.length
        ? round2(s.placements.reduce((a, b) => a + b, 0) / s.placements.length)
        : null,
    };
  });

  standings.sort(buildComparator(tiebreakers));
  standings.forEach((s, i) => { s.rank = i + 1; delete s.placements; });
  return standings;
}

/**
 * Standings plus per-team rank movement since the previous completed match,
 * which is what drives the up/down arrows in the UI.
 */
export function computeStandingsWithMovement(opts) {
  const standings = computeStandings(opts);

  const lastMatchNo = Math.max(0, ...standings.map((s) => s.last_match_no || 0));
  if (!lastMatchNo) {
    return standings.map((s) => ({ ...s, movement: 0, previous_rank: null }));
  }

  const previous = computeStandings({ ...opts, beforeMatchNo: lastMatchNo });
  const previousRank = new Map(previous.map((s) => [s.team_id, s.rank]));

  return standings.map((s) => {
    const before = previousRank.get(s.team_id) ?? null;
    // A team with no earlier results has no meaningful movement.
    const movement = before === null || !previous.some((p) => p.matches_played > 0) ? 0 : before - s.rank;
    return { ...s, previous_rank: before, movement };
  });
}

/** Standings split per group, for group-stage tables and per-group cuts. */
export function computeGroupStandings(opts) {
  const groups = all(
    `SELECT g.id, g.name, g.order_index FROM groups g
      WHERE g.tournament_id = ?${opts.stageId ? ' AND (g.stage_id = ? OR g.stage_id IS NULL)' : ''}
      ORDER BY g.order_index, g.name`,
    opts.stageId ? [opts.tournamentId, opts.stageId] : [opts.tournamentId],
  );
  return groups.map((group) => ({
    group,
    standings: computeStandings({ ...opts, groupId: group.id }),
  }));
}

/** Headline numbers for the dashboard and public statistics page. */
export function tournamentStats(tournamentId, tiebreakers) {
  const counts = all(
    `SELECT status, COUNT(*) AS n FROM matches WHERE tournament_id = ? GROUP BY status`,
    [tournamentId],
  );
  const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.n]));

  const totals = all(
    `SELECT COALESCE(SUM(r.kills), 0) AS kills, COUNT(DISTINCT r.match_id) AS scored
       FROM match_results r JOIN matches m ON m.id = r.match_id
      WHERE m.tournament_id = ? AND m.status = 'completed'`,
    [tournamentId],
  )[0] || { kills: 0, scored: 0 };

  const teamCount = all('SELECT COUNT(*) AS n FROM teams WHERE tournament_id = ?', [tournamentId])[0].n;

  // Read the cut from the most recently locked stage rather than team.status:
  // advancing a stage returns those teams to "active" for the new round, so
  // the status column would drop the count back to zero straight after.
  const lastLocked = all(
    `SELECT q.stage_id FROM qualifications q JOIN stages s ON s.id = q.stage_id
      WHERE q.tournament_id = ? ORDER BY s.order_index DESC LIMIT 1`,
    [tournamentId],
  )[0];
  const qualified = lastLocked
    ? all(
      "SELECT COUNT(*) AS n FROM qualifications WHERE stage_id = ? AND status = 'qualified'",
      [lastLocked.stage_id],
    )[0].n
    : all("SELECT COUNT(*) AS n FROM teams WHERE tournament_id = ? AND status = 'qualified'", [tournamentId])[0].n;

  const stillIn = all(
    "SELECT COUNT(*) AS n FROM teams WHERE tournament_id = ? AND status NOT IN ('eliminated','withdrawn')",
    [tournamentId],
  )[0].n;

  const standings = computeStandings({ tournamentId, tiebreakers });
  const leader = standings.find((s) => s.matches_played > 0) || null;
  const completed = byStatus.completed || 0;

  return {
    teams: teamCount,
    matches: Object.values(byStatus).reduce((a, b) => a + b, 0),
    completed,
    upcoming: byStatus.upcoming || 0,
    live: byStatus.live || 0,
    cancelled: byStatus.cancelled || 0,
    total_kills: totals.kills,
    avg_kills_per_match: completed ? round2(totals.kills / completed) : 0,
    qualified,
    still_in: stillIn,
    leader: leader ? { team_id: leader.team_id, name: leader.team_name, points: leader.total_points, logo_url: leader.logo_url } : null,
    top_fragger: [...standings].sort((a, b) => b.total_kills - a.total_kills)[0] || null,
  };
}

export const settingsTiebreakers = (settings) => parseJson(settings?.tiebreakers, DEFAULT_TIEBREAKERS);

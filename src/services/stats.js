/**
 * Player and team statistics.
 *
 * Two sources, and the distinction matters:
 *
 *  - `player_stats` holds real per-player kills, entered per match. When it is
 *    present these are true individual numbers.
 *  - Otherwise a player's figures are inherited from their team's results.
 *    Team points genuinely belong to the player; team kills do not, so they
 *    are reported as the team's, never as the player's own.
 *
 * Every endpoint that returns these says which source it used, so a "Top
 * Killers" board can never quietly present team kills as personal ones.
 */
import { all, get } from '../db.js';
import { round2 } from './scoring.js';

export const DEFAULT_MVP_WEIGHTS = { kills: 1, points: 0.5, wins: 2, damage: 0 };

/** Does this tournament have per-player kill data recorded? */
export const hasPlayerStats = (tournamentId) => get(
  `SELECT COUNT(*) AS n FROM player_stats ps
     JOIN matches m ON m.id = ps.match_id
    WHERE m.tournament_id = ?`,
  [tournamentId],
).n > 0;

/**
 * Per-player table for one tournament.
 * `source` is 'player_stats' when individual kills exist, else 'team'.
 */
export function playerLeaderboard(tournamentId, { limit = 50 } = {}) {
  const individual = hasPlayerStats(tournamentId);

  const rows = all(
    `SELECT p.id            AS player_id,
            p.user_id,
            p.name,
            p.in_game_id,
            p.is_captain,
            p.is_substitute,
            t.id            AS team_id,
            t.name          AS team_name,
            t.tag,
            t.logo_url,
            COUNT(DISTINCT r.match_id)                   AS matches,
            COALESCE(SUM(r.total_points), 0)             AS team_points,
            COALESCE(SUM(r.is_win), 0)                   AS wins,
            MIN(r.placement)                             AS best_placement,
            COALESCE(SUM(r.kills), 0)                    AS team_kills,
            COALESCE((SELECT SUM(ps.kills) FROM player_stats ps
                        JOIN matches m2 ON m2.id = ps.match_id
                       WHERE ps.player_id = p.id AND m2.status = 'completed'), 0) AS own_kills,
            COALESCE((SELECT SUM(ps.damage) FROM player_stats ps
                        JOIN matches m3 ON m3.id = ps.match_id
                       WHERE ps.player_id = p.id AND m3.status = 'completed'), 0) AS damage
       FROM players p
       JOIN teams t ON t.id = p.team_id
       LEFT JOIN match_results r ON r.team_id = t.id
       LEFT JOIN matches m ON m.id = r.match_id AND m.status = 'completed'
      WHERE t.tournament_id = ?
      GROUP BY p.id
      ORDER BY ${individual ? 'own_kills' : 'team_points'} DESC
      LIMIT ?`,
    [tournamentId, Math.min(500, limit)],
  );

  return {
    source: individual ? 'player_stats' : 'team',
    individual,
    players: rows.map((r) => decorate(r, individual)),
  };
}

function decorate(row, individual) {
  const matches = row.matches || 0;
  const kills = individual ? row.own_kills : null;
  return {
    ...row,
    kills,
    team_kills: row.team_kills,
    avg_kills: individual && matches ? round2(row.own_kills / matches) : null,
    team_points: round2(row.team_points),
    avg_points: matches ? round2(row.team_points / matches) : 0,
    best_placement: row.best_placement ?? null,
    damage: row.damage || 0,
  };
}

/** MVP ranking. Weights are configurable per tournament. */
export function mvpLeaderboard(tournamentId, { weights = DEFAULT_MVP_WEIGHTS, limit = 10 } = {}) {
  const { players, individual, source } = playerLeaderboard(tournamentId, { limit: 500 });
  const w = { ...DEFAULT_MVP_WEIGHTS, ...(weights || {}) };

  const scored = players
    .filter((p) => p.matches > 0)
    .map((p) => {
      const kills = individual ? (p.kills || 0) : 0;
      const score = kills * w.kills
        + (p.team_points || 0) * w.points
        + (p.wins || 0) * w.wins
        + (p.damage || 0) * (w.damage || 0);
      return { ...p, mvp_score: round2(score) };
    })
    .sort((a, b) => b.mvp_score - a.mvp_score || (b.kills || 0) - (a.kills || 0));

  return { source, individual, weights: w, players: scored.slice(0, limit) };
}

/** Team table for one tournament, including cross-tournament squad history. */
export function teamProfileStats(teamId) {
  const team = get(
    `SELECT t.*, tn.name AS tournament_name, tn.slug AS tournament_slug, g.name AS group_name
       FROM teams t JOIN tournaments tn ON tn.id = t.tournament_id
       LEFT JOIN groups g ON g.id = t.group_id
      WHERE t.id = ?`,
    [teamId],
  );
  if (!team) return null;

  const totals = get(
    `SELECT COUNT(DISTINCT r.match_id) AS matches,
            COALESCE(SUM(r.is_win), 0) AS wins,
            COALESCE(SUM(r.kills), 0) AS kills,
            COALESCE(SUM(r.total_points), 0) AS points,
            MIN(r.placement) AS best_placement
       FROM match_results r JOIN matches m ON m.id = r.match_id
      WHERE r.team_id = ? AND m.status = 'completed'`,
    [teamId],
  ) || {};

  const matches = totals.matches || 0;
  return {
    team,
    matches,
    wins: totals.wins || 0,
    kills: totals.kills || 0,
    points: round2(totals.points || 0),
    avg_points: matches ? round2((totals.points || 0) / matches) : 0,
    avg_kills: matches ? round2((totals.kills || 0) / matches) : 0,
    best_placement: totals.best_placement ?? null,
    players: all('SELECT * FROM players WHERE team_id = ? ORDER BY order_index, id', [teamId]),
    results: all(
      `SELECT r.*, m.match_no, m.label, m.scheduled_at, m.map, s.name AS stage_name
         FROM match_results r
         JOIN matches m ON m.id = r.match_id
         JOIN stages s ON s.id = m.stage_id
        WHERE r.team_id = ? AND m.status = 'completed'
        ORDER BY m.match_no`,
      [teamId],
    ),
  };
}

/**
 * Cross-tournament player profile, for a signed-up account.
 * Only counts tournaments where the player was linked to a user.
 */
export function playerCareer(userId) {
  const totals = get(
    `SELECT COUNT(DISTINCT r.match_id)             AS matches,
            COUNT(DISTINCT t.tournament_id)        AS tournaments,
            COALESCE(SUM(r.is_win), 0)             AS wins,
            COALESCE(SUM(r.total_points), 0)       AS team_points,
            MIN(r.placement)                       AS best_placement
       FROM players p
       JOIN teams t ON t.id = p.team_id
       JOIN match_results r ON r.team_id = t.id
       JOIN matches m ON m.id = r.match_id AND m.status = 'completed'
      WHERE p.user_id = ?`,
    [userId],
  ) || {};

  const own = get(
    `SELECT COALESCE(SUM(ps.kills), 0) AS kills, COALESCE(SUM(ps.damage), 0) AS damage,
            COUNT(*) AS scored_matches
       FROM player_stats ps
       JOIN players p ON p.id = ps.player_id
       JOIN matches m ON m.id = ps.match_id AND m.status = 'completed'
      WHERE p.user_id = ?`,
    [userId],
  ) || {};

  const matches = totals.matches || 0;
  return {
    matches,
    tournaments: totals.tournaments || 0,
    wins: totals.wins || 0,
    team_points: round2(totals.team_points || 0),
    avg_points: matches ? round2((totals.team_points || 0) / matches) : 0,
    best_placement: totals.best_placement ?? null,
    kills: own.kills || 0,
    avg_kills: own.scored_matches ? round2((own.kills || 0) / own.scored_matches) : null,
    damage: own.damage || 0,
    has_individual_stats: (own.scored_matches || 0) > 0,
  };
}

/** Global boards for the platform home page. */
export function globalLeaderboards({ limit = 10 } = {}) {
  const topTeams = all(
    `SELECT s.id, s.name, s.slug, s.tag, s.logo_url, s.game,
            COUNT(DISTINCT r.match_id)       AS matches,
            COALESCE(SUM(r.is_win), 0)       AS wins,
            COALESCE(SUM(r.kills), 0)        AS kills,
            COALESCE(SUM(r.total_points), 0) AS points
       FROM squads s
       JOIN teams t ON t.squad_id = s.id
       JOIN match_results r ON r.team_id = t.id
       JOIN matches m ON m.id = r.match_id AND m.status = 'completed'
      GROUP BY s.id
      ORDER BY points DESC, kills DESC
      LIMIT ?`,
    [limit],
  );

  const topPlayers = all(
    `SELECT u.id AS user_id, u.name, pp.ign, pp.avatar_url, pp.country,
            COALESCE(SUM(ps.kills), 0) AS kills,
            COUNT(DISTINCT ps.match_id) AS matches
       FROM player_stats ps
       JOIN players p ON p.id = ps.player_id
       JOIN users u ON u.id = p.user_id
       LEFT JOIN player_profiles pp ON pp.user_id = u.id
       JOIN matches m ON m.id = ps.match_id AND m.status = 'completed'
      GROUP BY u.id
      ORDER BY kills DESC
      LIMIT ?`,
    [limit],
  );

  return {
    teams: topTeams.map((t) => ({ ...t, points: round2(t.points) })),
    players: topPlayers,
  };
}

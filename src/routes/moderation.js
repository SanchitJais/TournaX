/**
 * Penalties and disqualifications, reusable scoring systems, per-player match
 * stats, and the result-correction history.
 */
import { all, get, insert, run, toJson, parseJson, tx } from '../db.js';
import { requireAbility, requireUser } from '../auth.js';
import { SYSTEM_SCORING_PRESETS, TIEBREAKER_KEYS } from '../config.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { PENALTY_KINDS, applyPenalty, listPenalties, revokePenalty } from '../services/penalties.js';
import { mvpLeaderboard, playerLeaderboard, teamProfileStats } from '../services/stats.js';
import { recordAudit, listAudit } from '../services/audit.js';
import { loadSettings, loadTournament, mergeSettings, expandSettings } from './tournaments.js';

/** Seed the built-in scoring systems once. */
export function ensureSystemPresets() {
  for (const preset of SYSTEM_SCORING_PRESETS) {
    if (get('SELECT id FROM scoring_presets WHERE name = ?', [preset.name])) continue;
    insert(
      'INSERT INTO scoring_presets (name, game, description, config, is_system) VALUES (?, ?, ?, ?, 1)',
      [preset.name, preset.game, preset.description, toJson(preset.config)],
    );
  }
}

export default function register(router) {
  // ------------------------------------------------------------ penalties --
  router.get('/api/tournaments/:id/penalties', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    loadTournament(tournamentId);
    return {
      penalties: listPenalties(tournamentId, { includeRevoked: ctx.query.all === '1' }),
      kinds: PENALTY_KINDS,
    };
  });

  router.post('/api/tournaments/:id/penalties', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'penalties:write', tournamentId);
    const tournament = loadTournament(tournamentId);
    return {
      __status: 201,
      penalty: applyPenalty({
        tournament,
        teamId: ctx.body.team_id,
        matchId: ctx.body.match_id,
        playerId: ctx.body.player_id,
        kind: ctx.body.kind,
        points: ctx.body.points,
        reason: ctx.body.reason,
        actor: ctx.user,
      }),
    };
  });

  router.delete('/api/tournaments/:id/penalties/:penaltyId', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'penalties:write', tournamentId);
    return revokePenalty({
      tournament: loadTournament(tournamentId),
      penaltyId: ctx.params.penaltyId,
      actor: ctx.user,
    });
  });

  // ------------------------------------------------------ scoring systems --
  router.get('/api/scoring-presets', () => {
    ensureSystemPresets();
    return {
      presets: all('SELECT * FROM scoring_presets ORDER BY is_system DESC, name')
        .map((p) => ({ ...p, config: parseJson(p.config, {}) })),
      tiebreakers: TIEBREAKER_KEYS,
    };
  });

  router.post('/api/scoring-presets', (ctx) => {
    const user = requireUser(ctx);
    const name = String(ctx.body.name || '').trim();
    if (!name) throw badRequest('Give the scoring system a name.');
    if (get('SELECT id FROM scoring_presets WHERE name = ?', [name])) {
      throw conflict('A scoring system with that name already exists.');
    }

    // Either save an explicit config, or capture a tournament's current rules.
    let config = ctx.body.config;
    if (ctx.body.tournament_id) {
      const tournamentId = Number(ctx.body.tournament_id);
      requireAbility(ctx, 'tournament:write', tournamentId);
      const settings = expandSettings(loadSettings(tournamentId));
      config = { scoring: settings.scoring, tiebreakers: settings.tiebreakers };
    }
    if (!config?.scoring) throw badRequest('Nothing to save -- no scoring rules supplied.');

    const id = insert(
      'INSERT INTO scoring_presets (name, game, description, config, is_system, owner_id) VALUES (?, ?, ?, ?, 0, ?)',
      [name, ctx.body.game || 'BGMI', ctx.body.description || null, toJson(config), user.id],
    );
    return { __status: 201, preset: { ...get('SELECT * FROM scoring_presets WHERE id = ?', [id]), config } };
  });

  router.delete('/api/scoring-presets/:id', (ctx) => {
    const user = requireUser(ctx);
    const preset = get('SELECT * FROM scoring_presets WHERE id = ?', [Number(ctx.params.id)]);
    if (!preset) throw notFound('Scoring system not found');
    if (preset.is_system && user.role !== 'super_admin') throw badRequest('Built-in scoring systems cannot be deleted.');
    if (!preset.is_system && preset.owner_id !== user.id && user.role !== 'super_admin') {
      throw badRequest('You can only delete scoring systems you created.');
    }
    run('DELETE FROM scoring_presets WHERE id = ?', [preset.id]);
    return { ok: true };
  });

  /** Apply a saved scoring system to a tournament. */
  router.post('/api/tournaments/:id/scoring-preset', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'tournament:write', tournamentId);
    const preset = get('SELECT * FROM scoring_presets WHERE id = ?', [Number(ctx.body.preset_id)]);
    if (!preset) throw notFound('Scoring system not found');

    const config = parseJson(preset.config, {});
    const merged = mergeSettings(expandSettings(loadSettings(tournamentId)), {
      scoring: config.scoring,
      tiebreakers: config.tiebreakers,
    });
    run(
      `UPDATE tournament_settings SET scoring = ?, tiebreakers = ?, updated_at = datetime('now')
        WHERE tournament_id = ?`,
      [toJson(merged.scoring), toJson(merged.tiebreakers), tournamentId],
    );

    recordAudit({
      tournamentId, actor: ctx.user, action: 'settings.updated', entity: 'tournament', entityId: tournamentId,
      summary: `Applied the "${preset.name}" scoring system.`, after: merged.scoring,
    });
    return { settings: merged };
  });

  // -------------------------------------------------- per-player match stats --
  router.get('/api/matches/:id/player-stats', (ctx) => {
    const matchId = Number(ctx.params.id);
    const match = get('SELECT * FROM matches WHERE id = ?', [matchId]);
    if (!match) throw notFound('Match not found');

    return {
      teams: all(
        `SELECT t.id AS team_id, t.name AS team_name, t.tag, t.logo_url
           FROM match_participants mp JOIN teams t ON t.id = mp.team_id
          WHERE mp.match_id = ? ORDER BY mp.slot`,
        [matchId],
      ).map((team) => ({
        ...team,
        players: all(
          `SELECT p.id, p.name, p.in_game_id, p.is_captain, p.is_substitute,
                  COALESCE(ps.kills, 0) AS kills, COALESCE(ps.damage, 0) AS damage,
                  COALESCE(ps.survival_seconds, 0) AS survival_seconds
             FROM players p LEFT JOIN player_stats ps ON ps.player_id = p.id AND ps.match_id = ?
            WHERE p.team_id = ? ORDER BY p.order_index, p.id`,
          [matchId, team.team_id],
        ),
      })),
    };
  });

  /**
   * Save per-player kills for a match. Optional data -- when present it powers
   * the individual kill board and MVP; when absent those fall back to team
   * figures and say so.
   */
  router.put('/api/matches/:id/player-stats', (ctx) => {
    const matchId = Number(ctx.params.id);
    const match = get('SELECT * FROM matches WHERE id = ?', [matchId]);
    if (!match) throw notFound('Match not found');
    requireAbility(ctx, 'results:write', match.tournament_id);

    const entries = ctx.body?.entries || [];
    const valid = new Set(all(
      `SELECT p.id FROM players p JOIN match_participants mp ON mp.team_id = p.team_id
        WHERE mp.match_id = ?`,
      [matchId],
    ).map((r) => r.id));

    let written = 0;
    tx(() => {
      for (const entry of entries) {
        const playerId = Number(entry.player_id);
        if (!valid.has(playerId)) continue;
        const kills = Math.max(0, Math.round(Number(entry.kills) || 0));
        const damage = Math.max(0, Math.round(Number(entry.damage) || 0));
        const survival = Math.max(0, Math.round(Number(entry.survival_seconds) || 0));

        run(
          `INSERT INTO player_stats (match_id, player_id, kills, damage, survival_seconds)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(match_id, player_id) DO UPDATE SET
             kills = excluded.kills, damage = excluded.damage,
             survival_seconds = excluded.survival_seconds`,
          [matchId, playerId, kills, damage, survival],
        );
        written += 1;
      }
    });

    recordAudit({
      tournamentId: match.tournament_id, actor: ctx.user, action: 'result.player_stats',
      entity: 'match', entityId: matchId,
      summary: `Recorded per-player stats for ${written} player(s) in ${match.label || `match ${match.match_no}`}.`,
    });
    return { written };
  });

  // -------------------------------------------------- statistics endpoints --
  router.get('/api/tournaments/:id/player-stats', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    loadTournament(tournamentId);
    const settings = expandSettings(loadSettings(tournamentId));
    return {
      ...playerLeaderboard(tournamentId, { limit: Number(ctx.query.limit) || 50 }),
      mvp: mvpLeaderboard(tournamentId, { weights: settings.scoring?.mvp, limit: 10 }),
    };
  });

  router.get('/api/teams/:id/profile', (ctx) => {
    const stats = teamProfileStats(Number(ctx.params.id));
    if (!stats) throw notFound('Team not found');
    return stats;
  });

  /**
   * Result corrections only -- the dispute trail. Every entry carries the
   * before and after values and who changed them.
   */
  router.get('/api/tournaments/:id/result-history', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'audit:read', tournamentId);

    const entries = listAudit(tournamentId, { limit: 200 })
      .filter((e) => e.action.startsWith('result.') || e.action.startsWith('penalty.'));

    const teamNames = new Map(
      all('SELECT id, name FROM teams WHERE tournament_id = ?', [tournamentId]).map((t) => [t.id, t.name]),
    );

    return {
      entries: entries.map((e) => {
        const before = parseJson(e.before_json, null);
        const after = parseJson(e.after_json, null);
        return {
          id: e.id,
          action: e.action,
          summary: e.summary,
          actor: e.actor_name,
          at: e.created_at,
          entity_id: e.entity_id,
          changes: diffResults(before, after, teamNames),
        };
      }),
    };
  });
}

/**
 * Turn two result snapshots into a plain list of what actually changed,
 * which is what an organizer needs when a team disputes a score.
 */
function diffResults(before, after, teamNames) {
  if (!Array.isArray(before) || !Array.isArray(after)) return [];
  const byTeam = new Map(before.map((r) => [r.team_id, r]));
  const changes = [];

  for (const row of after) {
    const old = byTeam.get(row.team_id);
    if (!old) {
      changes.push({ team: teamNames.get(row.team_id) || `Team ${row.team_id}`, field: 'result', from: null, to: describe(row) });
      continue;
    }
    for (const [field, label] of [['placement', 'placement'], ['kills', 'kills'], ['total', 'total points']]) {
      if (old[field] !== row[field]) {
        changes.push({
          team: teamNames.get(row.team_id) || `Team ${row.team_id}`,
          field: label, from: old[field], to: row[field],
        });
      }
    }
  }
  return changes;
}

const describe = (row) => `#${row.placement ?? '-'} · ${row.kills ?? 0} kills · ${row.total ?? 0} pts`;

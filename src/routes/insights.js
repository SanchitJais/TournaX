/** Leaderboard, statistics, qualification, notifications and audit history. */
import { all, get, parseJson, toJson, run } from '../db.js';
import { can, requireAbility, requireUser } from '../auth.js';
import { notFound } from '../lib/http.js';
import {
  computeGroupStandings, computeStandingsWithMovement, tournamentStats,
} from '../services/leaderboard.js';
import { lockQualification, previewQualification, storedQualification } from '../services/qualify.js';
import { listAudit } from '../services/audit.js';
import { listNotifications, markAllRead, markRead, unreadCount } from '../services/notify.js';
import { loadSettings, loadTournament } from './tournaments.js';

export default function register(router) {
  // --------------------------------------------------------- leaderboard -----
  router.get('/api/tournaments/:id/leaderboard', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    loadTournament(tournamentId);
    const settings = loadSettings(tournamentId);
    const tiebreakers = parseJson(settings.tiebreakers, []);

    const stageId = ctx.query.stage ? Number(ctx.query.stage) : null;
    const groupId = ctx.query.group ? Number(ctx.query.group) : null;

    return {
      tiebreakers,
      standings: computeStandingsWithMovement({ tournamentId, stageId, groupId, tiebreakers }),
      groups: ctx.query.split === 'groups'
        ? computeGroupStandings({ tournamentId, stageId, tiebreakers })
        : undefined,
    };
  });

  router.get('/api/tournaments/:id/stats', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    loadTournament(tournamentId);
    const tiebreakers = parseJson(loadSettings(tournamentId).tiebreakers, []);
    return {
      stats: tournamentStats(tournamentId, tiebreakers),
      kill_leaders: killLeaders(tournamentId),
      recent: recentResults(tournamentId, 6),
      progress: matchProgress(tournamentId),
    };
  });

  // -------------------------------------------------------- qualification ----
  /** Live view of who is currently through, recomputed on every request. */
  router.get('/api/stages/:id/qualification', (ctx) => {
    const stage = get('SELECT * FROM stages WHERE id = ?', [Number(ctx.params.id)]);
    if (!stage) throw notFound('Stage not found');
    const settings = loadSettings(stage.tournament_id);
    const rules = stage.qualification || settings.qualification;

    const preview = previewQualification({
      tournamentId: stage.tournament_id,
      stageId: stage.id,
      qualification: rules,
      tiebreakers: parseJson(settings.tiebreakers, []),
    });
    return {
      stage,
      ...preview,
      locked: storedQualification(stage.id),
    };
  });

  router.patch('/api/stages/:id/qualification', (ctx) => {
    const stage = get('SELECT * FROM stages WHERE id = ?', [Number(ctx.params.id)]);
    if (!stage) throw notFound('Stage not found');
    requireAbility(ctx, 'qualification:write', stage.tournament_id);
    run('UPDATE stages SET qualification = ? WHERE id = ?', [toJson(ctx.body), stage.id]);
    return { stage: get('SELECT * FROM stages WHERE id = ?', [stage.id]) };
  });

  router.post('/api/stages/:id/qualification/lock', (ctx) => {
    const stage = get('SELECT * FROM stages WHERE id = ?', [Number(ctx.params.id)]);
    if (!stage) throw notFound('Stage not found');
    requireAbility(ctx, 'qualification:write', stage.tournament_id);

    const settings = loadSettings(stage.tournament_id);
    const rules = ctx.body?.qualification
      ? toJson(ctx.body.qualification)
      : (stage.qualification || settings.qualification);

    if (ctx.body?.qualification) run('UPDATE stages SET qualification = ? WHERE id = ?', [rules, stage.id]);

    const result = lockQualification({
      tournamentId: stage.tournament_id,
      stageId: stage.id,
      qualification: rules,
      tiebreakers: parseJson(settings.tiebreakers, []),
      actor: ctx.user,
    });
    return {
      qualified: result.qualified,
      eliminated: result.eliminated,
      config: result.config,
    };
  });

  // -------------------------------------------------------- notifications ----
  router.get('/api/tournaments/:id/notifications', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    return {
      notifications: listNotifications(tournamentId, {
        limit: Number(ctx.query.limit) || 40,
        unreadOnly: ctx.query.unread === '1',
      }),
      unread: unreadCount(tournamentId),
    };
  });

  router.post('/api/notifications/read', (ctx) => {
    requireUser(ctx);
    markRead((ctx.body.ids || []).map(Number).filter(Boolean));
    return { ok: true };
  });

  router.post('/api/tournaments/:id/notifications/read-all', (ctx) => {
    requireUser(ctx);
    markAllRead(Number(ctx.params.id));
    return { ok: true };
  });

  // ---------------------------------------------------------------- audit ----
  router.get('/api/tournaments/:id/audit', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'audit:read', tournamentId);
    return {
      entries: listAudit(tournamentId, {
        limit: Number(ctx.query.limit) || 100,
        offset: Number(ctx.query.offset) || 0,
        action: ctx.query.action || null,
      }).map((e) => ({
        ...e,
        before: parseJson(e.before_json, null),
        after: parseJson(e.after_json, null),
        before_json: undefined,
        after_json: undefined,
      })),
    };
  });

  /** One call that fills the whole admin dashboard. */
  router.get('/api/tournaments/:id/dashboard', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    const tournament = loadTournament(tournamentId);
    const settings = loadSettings(tournamentId);
    const tiebreakers = parseJson(settings.tiebreakers, []);

    return {
      tournament,
      stats: tournamentStats(tournamentId, tiebreakers),
      standings: computeStandingsWithMovement({ tournamentId, tiebreakers }).slice(0, 10),
      upcoming: all(
        `SELECT m.id, m.match_no, m.label, m.scheduled_at, m.status, m.map, g.name AS group_name
           FROM matches m LEFT JOIN groups g ON g.id = m.group_id
          WHERE m.tournament_id = ? AND m.status IN ('upcoming','live')
          ORDER BY m.match_no LIMIT 6`,
        [tournamentId],
      ),
      recent: recentResults(tournamentId, 5),
      notifications: listNotifications(tournamentId, { limit: 8 }),
      unread: unreadCount(tournamentId),
      audit: can(ctx.user, 'audit:read', tournamentId) ? listAudit(tournamentId, { limit: 6 }) : [],
      progress: matchProgress(tournamentId),
    };
  });
}

function killLeaders(tournamentId, limit = 10) {
  return all(
    `SELECT t.id AS team_id, t.name, t.tag, t.logo_url,
            SUM(r.kills) AS kills, COUNT(*) AS matches,
            ROUND(CAST(SUM(r.kills) AS REAL) / COUNT(*), 2) AS avg_kills
       FROM match_results r
       JOIN matches m ON m.id = r.match_id
       JOIN teams t ON t.id = r.team_id
      WHERE m.tournament_id = ? AND m.status = 'completed'
      GROUP BY t.id ORDER BY kills DESC, avg_kills DESC LIMIT ?`,
    [tournamentId, limit],
  );
}

function recentResults(tournamentId, limit = 5) {
  const matches = all(
    `SELECT m.id, m.match_no, m.label, m.scheduled_at, m.map, g.name AS group_name
       FROM matches m LEFT JOIN groups g ON g.id = m.group_id
      WHERE m.tournament_id = ? AND m.status = 'completed'
      ORDER BY m.match_no DESC LIMIT ?`,
    [tournamentId, limit],
  );
  return matches.map((m) => ({
    ...m,
    top: all(
      `SELECT r.placement, r.kills, r.total_points, t.name, t.tag, t.logo_url
         FROM match_results r JOIN teams t ON t.id = r.team_id
        WHERE r.match_id = ? ORDER BY COALESCE(r.placement, 999) LIMIT 3`,
      [m.id],
    ),
  }));
}

/** Points accumulated per completed match -- drives the dashboard chart. */
function matchProgress(tournamentId) {
  return all(
    `SELECT m.match_no, m.label,
            COALESCE(SUM(r.kills), 0) AS kills,
            COALESCE(SUM(r.total_points), 0) AS points,
            COUNT(r.id) AS teams
       FROM matches m LEFT JOIN match_results r ON r.match_id = m.id
      WHERE m.tournament_id = ? AND m.status = 'completed'
      GROUP BY m.id ORDER BY m.match_no`,
    [tournamentId],
  );
}

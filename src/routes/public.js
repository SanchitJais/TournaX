/**
 * Public, read-only tournament API. No authentication, nothing sensitive:
 * room credentials appear only once their reveal time has passed, and
 * captain contact details are never exposed.
 */
import { all, get, parseJson } from '../db.js';
import { notFound } from '../lib/http.js';
import { computeGroupStandings, computeStandingsWithMovement, tournamentStats } from '../services/leaderboard.js';
import { previewQualification, storedQualification } from '../services/qualify.js';
import { listMatches, matchDetail, participantTeamIds } from './matches.js';
import { loadSettings } from './tournaments.js';

function publicTournament(slug) {
  const tournament = get('SELECT * FROM tournaments WHERE slug = ? AND is_public = 1', [slug])
    || get('SELECT * FROM tournaments WHERE id = ? AND is_public = 1', [Number(slug) || 0]);
  if (!tournament) throw notFound('That tournament is not available.');
  return tournament;
}

export default function register(router) {
  router.get('/api/public/tournaments', () => ({
    tournaments: all(
      `SELECT id, slug, name, game, banner_url, logo_url, format_type, status,
              start_date, end_date, prize_pool, num_teams
         FROM tournaments WHERE is_public = 1
        ORDER BY CASE status WHEN 'live' THEN 0 WHEN 'draft' THEN 2 ELSE 1 END, start_date DESC`,
    ).map((t) => ({
      ...t,
      team_count: get('SELECT COUNT(*) AS n FROM teams WHERE tournament_id = ?', [t.id]).n,
      completed: get("SELECT COUNT(*) AS n FROM matches WHERE tournament_id = ? AND status = 'completed'", [t.id]).n,
      matches: get('SELECT COUNT(*) AS n FROM matches WHERE tournament_id = ?', [t.id]).n,
    })),
  }));

  /** Everything the public landing page needs in one request. */
  router.get('/api/public/t/:slug', (ctx) => {
    const tournament = publicTournament(ctx.params.slug);
    const settings = loadSettings(tournament.id);
    const tiebreakers = parseJson(settings.tiebreakers, []);
    const matches = listMatches(tournament.id, {
      privileged: false,
      participantTeams: participantTeamIds(ctx.user, tournament.id),
    });

    return {
      tournament: strip(tournament),
      stats: tournamentStats(tournament.id, tiebreakers),
      stages: all('SELECT id, name, kind, order_index, status FROM stages WHERE tournament_id = ? ORDER BY order_index', [tournament.id]),
      groups: all('SELECT id, name, order_index FROM groups WHERE tournament_id = ? ORDER BY order_index', [tournament.id]),
      standings: computeStandingsWithMovement({ tournamentId: tournament.id, tiebreakers }),
      live: matches.filter((m) => m.status === 'live'),
      upcoming: matches.filter((m) => m.status === 'upcoming').slice(0, 8),
      recent: matches.filter((m) => m.status === 'completed').slice(-6).reverse(),
      scoring: parseJson(settings.scoring, {}),
    };
  });

  router.get('/api/public/t/:slug/matches', (ctx) => {
    const tournament = publicTournament(ctx.params.slug);
    return {
      matches: listMatches(tournament.id, {
        privileged: false,
        participantTeams: participantTeamIds(ctx.user, tournament.id),
        stageId: ctx.query.stage ? Number(ctx.query.stage) : null,
        status: ctx.query.status || null,
        search: ctx.query.search || '',
      }),
      stages: all('SELECT id, name FROM stages WHERE tournament_id = ? ORDER BY order_index', [tournament.id]),
    };
  });

  router.get('/api/public/t/:slug/match/:matchId', (ctx) => {
    const tournament = publicTournament(ctx.params.slug);
    const id = Number(ctx.params.matchId);
    const match = get('SELECT id FROM matches WHERE tournament_id = ? AND (id = ? OR match_no = ?)', [tournament.id, id, id]);
    if (!match) throw notFound('Match not found');
    return {
      tournament: strip(tournament),
      match: matchDetail(match.id, {
        privileged: false,
        participantTeams: participantTeamIds(ctx.user, tournament.id),
      }),
    };
  });

  router.get('/api/public/t/:slug/leaderboard', (ctx) => {
    const tournament = publicTournament(ctx.params.slug);
    const settings = loadSettings(tournament.id);
    const tiebreakers = parseJson(settings.tiebreakers, []);
    const stageId = ctx.query.stage ? Number(ctx.query.stage) : null;
    return {
      tiebreakers,
      standings: computeStandingsWithMovement({ tournamentId: tournament.id, stageId, tiebreakers }),
      groups: computeGroupStandings({ tournamentId: tournament.id, stageId, tiebreakers }),
    };
  });

  router.get('/api/public/t/:slug/teams', (ctx) => {
    const tournament = publicTournament(ctx.params.slug);
    const teams = all(
      `SELECT t.id, t.name, t.tag, t.team_code, t.logo_url, t.status, t.seed, g.name AS group_name
         FROM teams t LEFT JOIN groups g ON g.id = t.group_id
        WHERE t.tournament_id = ? ORDER BY COALESCE(t.seed, 9999), t.name`,
      [tournament.id],
    );
    const players = all(
      `SELECT p.team_id, p.name, p.in_game_id, p.is_captain FROM players p
         JOIN teams t ON t.id = p.team_id WHERE t.tournament_id = ?
        ORDER BY p.order_index, p.id`,
      [tournament.id],
    );
    const byTeam = new Map();
    for (const p of players) {
      if (!byTeam.has(p.team_id)) byTeam.set(p.team_id, []);
      byTeam.get(p.team_id).push(p);
    }
    return { teams: teams.map((t) => ({ ...t, players: byTeam.get(t.id) || [] })) };
  });

  router.get('/api/public/t/:slug/qualification', (ctx) => {
    const tournament = publicTournament(ctx.params.slug);
    const settings = loadSettings(tournament.id);
    const stage = ctx.query.stage
      ? get('SELECT * FROM stages WHERE id = ?', [Number(ctx.query.stage)])
      : get(
        `SELECT * FROM stages WHERE tournament_id = ?
          ORDER BY CASE status WHEN 'live' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END, order_index DESC LIMIT 1`,
        [tournament.id],
      );
    if (!stage) return { qualified: [], eliminated: [], stage: null };

    const locked = storedQualification(stage.id);
    if (locked.length) {
      return {
        stage,
        locked: true,
        qualified: locked.filter((q) => q.status === 'qualified'),
        eliminated: locked.filter((q) => q.status === 'eliminated'),
      };
    }
    const preview = previewQualification({
      tournamentId: tournament.id,
      stageId: stage.id,
      qualification: stage.qualification || settings.qualification,
      tiebreakers: parseJson(settings.tiebreakers, []),
    });
    return {
      stage,
      locked: false,
      config: preview.config,
      qualified: preview.qualified,
      eliminated: preview.eliminated,
    };
  });

  /** Tournament rules, already sanitised at write time. */
  router.get('/api/public/t/:slug/rules', (ctx) => {
    const tournament = publicTournament(ctx.params.slug);
    const settings = loadSettings(tournament.id);
    return {
      rules_html: tournament.rules_html || '',
      entry_requirements: tournament.entry_requirements || '',
      scoring: parseJson(settings.scoring, {}),
      tiebreakers: parseJson(settings.tiebreakers, []),
      qualification: parseJson(settings.qualification, {}),
      format: {
        type: tournament.format_type, match_format: tournament.match_format,
        num_teams: tournament.num_teams, num_groups: tournament.num_groups,
        teams_per_match: tournament.teams_per_match,
        min_players: tournament.min_players, max_players: tournament.max_players,
      },
    };
  });

  /**
   * The stage-by-stage flow spectators follow:
   * Registration -> Group Stage -> ... -> Grand Final -> Champion.
   */
  router.get('/api/public/t/:slug/progression', (ctx) => {
    const tournament = publicTournament(ctx.params.slug);
    const settings = loadSettings(tournament.id);
    const tiebreakers = parseJson(settings.tiebreakers, []);
    const stages = all('SELECT * FROM stages WHERE tournament_id = ? ORDER BY order_index', [tournament.id]);

    const steps = stages.map((stage) => {
      const counts = get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN status = 'live' THEN 1 ELSE 0 END) AS live,
                SUM(CASE WHEN status = 'upcoming' THEN 1 ELSE 0 END) AS upcoming
           FROM matches WHERE stage_id = ?`,
        [stage.id],
      );
      const locked = storedQualification(stage.id);
      return {
        id: stage.id,
        name: stage.name,
        kind: stage.kind,
        status: stage.status,
        matches: counts.total || 0,
        completed: counts.completed || 0,
        live: counts.live || 0,
        upcoming: counts.upcoming || 0,
        teams: get('SELECT COUNT(DISTINCT team_id) AS n FROM match_participants mp JOIN matches m ON m.id = mp.match_id WHERE m.stage_id = ?', [stage.id]).n,
        qualified: locked.filter((q) => q.status === 'qualified').map((q) => ({ team_name: q.team_name, tag: q.tag, logo_url: q.logo_url, rank: q.rank })),
        eliminated: locked.filter((q) => q.status === 'eliminated').length,
        locked: locked.length > 0,
      };
    });

    // The champion is the leader of the final stage once it is complete.
    const finalStage = stages[stages.length - 1];
    let champion = null;
    if (finalStage && finalStage.status === 'completed') {
      const table = computeStandingsWithMovement({ tournamentId: tournament.id, stageId: finalStage.id, tiebreakers });
      champion = table.find((s) => s.matches_played > 0) || null;
    }

    return {
      registration: {
        open: Boolean(tournament.registration_open),
        deadline: tournament.registration_deadline,
        registered: get("SELECT COUNT(*) AS n FROM tournament_registrations WHERE tournament_id = ? AND status = 'approved'", [tournament.id]).n,
        slots: tournament.slots || tournament.num_teams,
      },
      steps,
      champion,
      status: tournament.status,
    };
  });

  /** Live mode: what is happening right now. */
  router.get('/api/public/t/:slug/live', (ctx) => {
    const tournament = publicTournament(ctx.params.slug);
    const settings = loadSettings(tournament.id);
    const tiebreakers = parseJson(settings.tiebreakers, []);
    const participantTeams = participantTeamIds(ctx.user, tournament.id);
    const matches = listMatches(tournament.id, { privileged: false, participantTeams });

    const live = matches.filter((m) => m.status === 'live');
    const latest = matches.filter((m) => m.status === 'completed').slice(-1)[0] || null;

    return {
      tournament: strip(tournament),
      live,
      next: matches.find((m) => m.status === 'upcoming') || null,
      latest_result: latest
        ? {
          ...latest,
          results: all(
            `SELECT r.*, t.name AS team_name, t.tag, t.logo_url FROM match_results r
               JOIN teams t ON t.id = r.team_id WHERE r.match_id = ?
              ORDER BY COALESCE(r.placement, 999)`,
            [latest.id],
          ),
        }
        : null,
      standings: computeStandingsWithMovement({ tournamentId: tournament.id, tiebreakers }).slice(0, 20),
      stats: tournamentStats(tournament.id, tiebreakers),
      updated_at: new Date().toISOString(),
    };
  });

  router.get('/api/public/t/:slug/stats', (ctx) => {
    const tournament = publicTournament(ctx.params.slug);
    const tiebreakers = parseJson(loadSettings(tournament.id).tiebreakers, []);
    const standings = computeStandingsWithMovement({ tournamentId: tournament.id, tiebreakers });
    return {
      stats: tournamentStats(tournament.id, tiebreakers),
      kill_leaders: [...standings].sort((a, b) => b.total_kills - a.total_kills).slice(0, 10),
      consistency: [...standings]
        .filter((s) => s.matches_played > 0)
        .sort((a, b) => b.avg_points - a.avg_points)
        .slice(0, 10),
      most_wins: [...standings].sort((a, b) => b.wins - a.wins).slice(0, 10),
      per_match: all(
        `SELECT m.match_no, m.label, m.map,
                COALESCE(SUM(r.kills), 0) AS kills,
                COUNT(r.id) AS teams
           FROM matches m LEFT JOIN match_results r ON r.match_id = m.id
          WHERE m.tournament_id = ? AND m.status = 'completed'
          GROUP BY m.id ORDER BY m.match_no`,
        [tournament.id],
      ),
    };
  });
}

/** Drop internal/owner fields from anything sent to spectators. */
const strip = (t) => ({
  id: t.id, slug: t.slug, name: t.name, game: t.game, format_type: t.format_type,
  match_format: t.match_format, description: t.description, banner_url: t.banner_url,
  logo_url: t.logo_url, start_date: t.start_date, end_date: t.end_date,
  prize_pool: t.prize_pool, status: t.status, num_teams: t.num_teams,
});

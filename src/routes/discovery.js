/** Public tournament discovery, global search, and platform-wide leaderboards. */
import { all, get, parseJson } from '../db.js';
import { GAMES, FORMAT_TYPES, REGIONS } from '../config.js';
import { htmlToText } from '../lib/sanitize.js';
import { registrationCounts } from '../services/registrations.js';
import { globalLeaderboards } from '../services/stats.js';

export default function register(router) {
  /** Filter vocabulary for the discovery page. */
  router.get('/api/discover/filters', () => ({
    games: GAMES,
    formats: FORMAT_TYPES,
    regions: REGIONS,
    organizers: all(
      `SELECT DISTINCT COALESCE(NULLIF(t.organizer_name, ''), u.name) AS name
         FROM tournaments t LEFT JOIN users u ON u.id = t.owner_id
        WHERE t.is_public = 1 AND COALESCE(NULLIF(t.organizer_name, ''), u.name) IS NOT NULL
        ORDER BY name`,
    ).map((r) => r.name),
    statuses: [
      { value: 'upcoming', label: 'Upcoming' },
      { value: 'live', label: 'Live' },
      { value: 'completed', label: 'Completed' },
      { value: 'registering', label: 'Registration open' },
    ],
  }));

  /**
   * Browse tournaments. Every filter is optional; `mine=1` needs a session and
   * narrows to tournaments the caller's teams have entered.
   */
  router.get('/api/discover', (ctx) => {
    const q = ctx.query;
    const where = ['t.is_public = 1'];
    const params = [];

    if (q.game) { where.push('t.game = ?'); params.push(q.game); }
    if (q.format) { where.push('t.format_type = ?'); params.push(q.format); }
    if (q.region) { where.push('t.region = ?'); params.push(q.region); }
    if (q.organizer) {
      where.push("COALESCE(NULLIF(t.organizer_name, ''), (SELECT name FROM users WHERE id = t.owner_id)) = ?");
      params.push(q.organizer);
    }
    if (q.search) {
      where.push('(t.name LIKE ? OR t.game LIKE ? OR t.description LIKE ?)');
      const like = `%${q.search}%`;
      params.push(like, like, like);
    }
    if (q.from) { where.push('(t.start_date IS NULL OR t.start_date >= ?)'); params.push(q.from); }
    if (q.to) { where.push('(t.start_date IS NULL OR t.start_date <= ?)'); params.push(q.to); }

    if (q.status === 'live') where.push("t.status = 'live'");
    else if (q.status === 'completed') where.push("t.status IN ('completed','archived')");
    else if (q.status === 'upcoming') where.push("t.status IN ('draft','live') AND (t.start_date IS NULL OR date(t.start_date) >= date('now'))");
    else if (q.status === 'registering') where.push('t.registration_open = 1');

    if (q.mine === '1' && ctx.user) {
      where.push(`t.id IN (
        SELECT r.tournament_id FROM tournament_registrations r
         WHERE r.status != 'withdrawn'
           AND r.squad_id IN (SELECT squad_id FROM squad_members WHERE user_id = ? AND status = 'active'))`);
      params.push(ctx.user.id);
    }

    const rows = all(
      `SELECT t.id, t.slug, t.name, t.game, t.format_type, t.match_format, t.status, t.region,
              t.banner_url, t.logo_url, t.prize_pool, t.start_date, t.end_date, t.num_teams,
              t.slots, t.registration_open, t.registration_deadline, t.description,
              COALESCE(NULLIF(t.organizer_name, ''), u.name) AS organizer,
              (SELECT COUNT(*) FROM teams tm WHERE tm.tournament_id = t.id) AS team_count,
              (SELECT COUNT(*) FROM matches m WHERE m.tournament_id = t.id) AS match_count,
              (SELECT COUNT(*) FROM matches m WHERE m.tournament_id = t.id AND m.status = 'completed') AS completed_count
         FROM tournaments t LEFT JOIN users u ON u.id = t.owner_id
        WHERE ${where.join(' AND ')}
        ORDER BY CASE t.status WHEN 'live' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
                 COALESCE(t.start_date, t.created_at) DESC
        LIMIT ?`,
      [...params, Math.min(120, Number(q.limit) || 60)],
    );

    return {
      tournaments: rows.map((t) => ({
        ...t,
        registered: registrationCounts(t.id).total,
        summary: t.description ? htmlToText(t.description, 140) : null,
      })),
    };
  });

  /** Platform home: headline counts plus global leaderboards. */
  router.get('/api/discover/home', () => {
    const counts = get(
      `SELECT
         (SELECT COUNT(*) FROM tournaments WHERE is_public = 1)                       AS tournaments,
         (SELECT COUNT(*) FROM tournaments WHERE is_public = 1 AND status = 'live')   AS live,
         (SELECT COUNT(*) FROM tournaments WHERE is_public = 1 AND registration_open = 1) AS registering,
         (SELECT COUNT(*) FROM squads)                                                AS teams,
         (SELECT COUNT(*) FROM player_profiles)                                       AS players,
         (SELECT COUNT(*) FROM matches WHERE status = 'completed')                    AS matches_played`,
    );

    return {
      counts,
      leaderboards: globalLeaderboards({ limit: 8 }),
      featured: all(
        `SELECT t.id, t.slug, t.name, t.game, t.banner_url, t.logo_url, t.prize_pool,
                t.start_date, t.status, t.registration_open,
                (SELECT COUNT(*) FROM teams tm WHERE tm.tournament_id = t.id) AS team_count
           FROM tournaments t
          WHERE t.is_public = 1 AND t.status IN ('live','draft')
          ORDER BY CASE t.status WHEN 'live' THEN 0 ELSE 1 END, t.start_date
          LIMIT 6`,
      ),
    };
  });

  /**
   * Global search across tournaments, teams, players and matches.
   * Public data only -- contact details are never returned here.
   */
  router.get('/api/search', (ctx) => {
    const term = String(ctx.query.q || '').trim();
    if (term.length < 2) return { query: term, results: [], total: 0 };
    const like = `%${term}%`;
    const limit = Math.min(10, Number(ctx.query.limit) || 6);

    const tournaments = all(
      `SELECT id, slug, name, game, status, start_date, logo_url
         FROM tournaments WHERE is_public = 1 AND (name LIKE ? OR game LIKE ?)
        ORDER BY CASE status WHEN 'live' THEN 0 ELSE 1 END LIMIT ?`,
      [like, like, limit],
    );

    const squads = all(
      `SELECT s.id, s.slug, s.name, s.tag, s.logo_url, s.game,
              (SELECT COUNT(*) FROM squad_members m WHERE m.squad_id = s.id AND m.status = 'active') AS member_count
         FROM squads s WHERE s.name LIKE ? OR s.tag LIKE ? ORDER BY s.name LIMIT ?`,
      [like, like, limit],
    );

    const players = all(
      `SELECT u.id, u.name, p.ign, p.avatar_url, p.country
         FROM player_profiles p JOIN users u ON u.id = p.user_id
        WHERE u.is_active = 1 AND (p.ign LIKE ? OR u.name LIKE ?)
        ORDER BY p.ign LIMIT ?`,
      [like, like, limit],
    );

    // Teams entered in tournaments (covers historic teams with no squad).
    const entries = all(
      `SELECT t.id, t.name, t.tag, t.logo_url, t.squad_id, tn.slug AS tournament_slug, tn.name AS tournament_name
         FROM teams t JOIN tournaments tn ON tn.id = t.tournament_id
        WHERE tn.is_public = 1 AND t.name LIKE ? ORDER BY t.name LIMIT ?`,
      [like, limit],
    );

    const matches = all(
      `SELECT m.id, m.match_no, m.label, m.status, m.scheduled_at,
              tn.slug AS tournament_slug, tn.name AS tournament_name
         FROM matches m JOIN tournaments tn ON tn.id = m.tournament_id
        WHERE tn.is_public = 1 AND (m.label LIKE ? OR CAST(m.match_no AS TEXT) = ?)
        ORDER BY m.match_no LIMIT ?`,
      [like, term, limit],
    );

    const results = [
      ...tournaments.map((t) => ({
        kind: 'tournament', id: t.id, title: t.name,
        subtitle: `${t.game}${t.start_date ? ` · ${t.start_date}` : ''}`,
        badge: t.status, image: t.logo_url, href: `/tournament/${t.slug}`,
      })),
      ...squads.map((s) => ({
        kind: 'team', id: s.id, title: s.name,
        subtitle: `${s.game} · ${s.member_count} player(s)`,
        badge: s.tag, image: s.logo_url, href: `/team/${s.slug}`,
      })),
      ...players.map((p) => ({
        kind: 'player', id: p.id, title: p.ign || p.name,
        subtitle: p.ign && p.ign !== p.name ? p.name : (p.country || 'Player'),
        image: p.avatar_url, href: `/player/${p.id}`,
      })),
      ...entries.filter((e) => !squads.some((s) => s.id === e.squad_id)).map((e) => ({
        kind: 'team', id: e.id, title: e.name,
        subtitle: `in ${e.tournament_name}`, image: e.logo_url,
        href: `/tournament/${e.tournament_slug}/teams`,
      })),
      ...matches.map((m) => ({
        kind: 'match', id: m.id, title: m.label || `Match ${m.match_no}`,
        subtitle: `${m.tournament_name}${m.scheduled_at ? ` · ${m.scheduled_at}` : ''}`,
        badge: m.status, href: `/t/match/${m.id}`,
      })),
    ];

    return { query: term, results, total: results.length };
  });
}

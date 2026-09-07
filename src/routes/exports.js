/**
 * Downloads: CSV, Excel, PDF and a full JSON backup.
 * URL shape: /api/tournaments/:id/export/:kind.:format
 */
import { all, parseJson } from '../db.js';
import { requireAbility } from '../auth.js';
import { badRequest, sendFileDownload } from '../lib/http.js';
import { toCsv } from '../lib/csv.js';
import { XLSX_MIME, buildXlsx } from '../lib/xlsx.js';
import { PDF_MIME, renderTablePdf } from '../lib/pdf.js';
import { computeStandingsWithMovement, tournamentStats } from '../services/leaderboard.js';
import { listMatches } from './matches.js';
import { expandSettings, loadSettings, loadTournament } from './tournaments.js';

const fileSafe = (name) => String(name).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

/** Column definitions shared by every output format. */
const DATASETS = {
  leaderboard: (tournamentId, tiebreakers) => ({
    title: 'Leaderboard',
    columns: [
      { label: '#', key: 'rank', align: 'right', max: 42 },
      { label: 'Team', key: 'team_name', bold: true },
      { label: 'Group', key: 'group_name' },
      { label: 'Played', key: 'matches_played', align: 'right' },
      { label: 'Wins', key: 'wins', align: 'right' },
      { label: 'Place Pts', key: 'placement_points', align: 'right' },
      { label: 'Kill Pts', key: 'kill_points', align: 'right' },
      { label: 'Bonus', key: 'bonus_points', align: 'right' },
      { label: 'Penalty', key: 'penalty_points', align: 'right' },
      { label: 'Kills', key: 'total_kills', align: 'right' },
      { label: 'Avg Kills', key: 'avg_kills', align: 'right' },
      { label: 'Avg Pts', key: 'avg_points', align: 'right' },
      { label: 'Total', key: 'total_points', align: 'right', bold: true },
    ],
    rows: computeStandingsWithMovement({ tournamentId, tiebreakers }),
  }),

  schedule: (tournamentId) => ({
    title: 'Match Schedule',
    columns: [
      { label: 'Match', key: 'match_no', align: 'right', max: 60 },
      { label: 'Stage', key: 'stage_name' },
      { label: 'Round', key: 'round_name' },
      { label: 'Group', key: 'group_name' },
      { label: 'Teams', key: 'team_names', max: 300 },
      { label: 'Map', key: 'map' },
      { label: 'Date', key: 'date' },
      { label: 'Time', key: 'time' },
      { label: 'Status', key: 'status' },
    ],
    rows: listMatches(tournamentId, { privileged: false }).map((m) => ({
      ...m,
      team_names: m.teams.map((t) => t.name).join(', '),
      date: (m.scheduled_at || '').slice(0, 10),
      time: (m.scheduled_at || '').slice(11, 16),
      status: m.status,
    })),
  }),

  teams: (tournamentId) => ({
    title: 'Registered Teams',
    columns: [
      { label: 'Team Name', key: 'name', bold: true },
      { label: 'Tag', key: 'tag' },
      { label: 'Team ID', key: 'team_code' },
      { label: 'Captain Name', key: 'captain_name' },
      { label: 'Captain Contact', key: 'captain_contact' },
      { label: 'Group', key: 'group_name' },
      { label: 'Seed', key: 'seed', align: 'right' },
      { label: 'Status', key: 'status' },
      { label: 'Players', key: 'player_names', max: 280 },
    ],
    rows: (() => {
      const teams = all(
        `SELECT t.*, g.name AS group_name FROM teams t
           LEFT JOIN groups g ON g.id = t.group_id
          WHERE t.tournament_id = ? ORDER BY COALESCE(t.seed, 9999), t.name`,
        [tournamentId],
      );
      const players = all(
        `SELECT p.team_id, p.name, p.in_game_id FROM players p
           JOIN teams t ON t.id = p.team_id WHERE t.tournament_id = ?
          ORDER BY p.order_index, p.id`,
        [tournamentId],
      );
      const byTeam = new Map();
      for (const p of players) {
        if (!byTeam.has(p.team_id)) byTeam.set(p.team_id, []);
        byTeam.get(p.team_id).push(p.in_game_id ? `${p.name} (${p.in_game_id})` : p.name);
      }
      return teams.map((t) => ({ ...t, player_names: (byTeam.get(t.id) || []).join(', ') }));
    })(),
  }),

  results: (tournamentId) => ({
    title: 'All Match Results',
    columns: [
      { label: 'Match', key: 'match_no', align: 'right', max: 60 },
      { label: 'Stage', key: 'stage_name' },
      { label: 'Group', key: 'group_name' },
      { label: 'Team', key: 'team_name', bold: true },
      { label: 'Place', key: 'placement', align: 'right' },
      { label: 'Kills', key: 'kills', align: 'right' },
      { label: 'Place Pts', key: 'placement_points', align: 'right' },
      { label: 'Kill Pts', key: 'kill_points', align: 'right' },
      { label: 'Bonus', key: 'bonus_points', align: 'right' },
      { label: 'Penalty', key: 'penalty_points', align: 'right' },
      { label: 'Total', key: 'total_points', align: 'right', bold: true },
    ],
    rows: all(
      `SELECT m.match_no, s.name AS stage_name, g.name AS group_name, t.name AS team_name,
              r.placement, r.kills, r.placement_points, r.kill_points, r.bonus_points,
              r.penalty_points, r.total_points
         FROM match_results r
         JOIN matches m ON m.id = r.match_id
         JOIN stages s ON s.id = m.stage_id
         LEFT JOIN groups g ON g.id = m.group_id
         JOIN teams t ON t.id = r.team_id
        WHERE m.tournament_id = ?
        ORDER BY m.match_no, COALESCE(r.placement, 999)`,
      [tournamentId],
    ),
  }),
};

export default function register(router) {
  router.get('/api/tournaments/:id/export/:file', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'export', tournamentId);
    const tournament = loadTournament(tournamentId);

    const dot = ctx.params.file.lastIndexOf('.');
    if (dot < 0) throw badRequest('Ask for a file like "leaderboard.pdf".');
    const kind = ctx.params.file.slice(0, dot);
    const format = ctx.params.file.slice(dot + 1).toLowerCase();

    const settings = loadSettings(tournamentId);
    const tiebreakers = parseJson(settings.tiebreakers, []);
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `${fileSafe(tournament.name)}-${kind}-${stamp}`;

    // Whole-tournament backup.
    if (kind === 'tournament' || kind === 'all') {
      if (format === 'json') {
        const payload = fullBackup(tournamentId, tournament, settings);
        return sendFileDownload(
          ctx.res, `${base}.json`,
          Buffer.from(JSON.stringify(payload, null, 2), 'utf8'),
          'application/json; charset=utf-8',
        );
      }
      if (format === 'xlsx') {
        const sheets = ['leaderboard', 'schedule', 'teams', 'results'].map((k) => {
          const set = DATASETS[k](tournamentId, tiebreakers);
          return {
            name: set.title.slice(0, 31),
            headers: set.columns.map((c) => c.label),
            rows: set.rows.map((row) => set.columns.map((c) => cellValue(row, c))),
          };
        });
        return sendFileDownload(ctx.res, `${base}.xlsx`, buildXlsx(sheets), XLSX_MIME);
      }
      throw badRequest('A full export is available as .xlsx or .json.');
    }

    const dataset = DATASETS[kind];
    if (!dataset) throw badRequest(`Unknown export "${kind}". Try leaderboard, schedule, teams, results or tournament.`);
    const { title, columns, rows } = dataset(tournamentId, tiebreakers);

    if (format === 'csv') {
      const csv = toCsv(rows, columns.map((c) => ({ label: c.label, key: c.key, get: (row) => cellValue(row, c) })));
      return sendFileDownload(ctx.res, `${base}.csv`, Buffer.from(csv, 'utf8'), 'text/csv; charset=utf-8');
    }
    if (format === 'xlsx') {
      const buffer = buildXlsx([{
        name: title.slice(0, 31),
        headers: columns.map((c) => c.label),
        rows: rows.map((row) => columns.map((c) => cellValue(row, c))),
      }]);
      return sendFileDownload(ctx.res, `${base}.xlsx`, buffer, XLSX_MIME);
    }
    if (format === 'json') {
      return sendFileDownload(
        ctx.res, `${base}.json`,
        Buffer.from(JSON.stringify({ tournament: tournament.name, kind, rows }, null, 2), 'utf8'),
        'application/json; charset=utf-8',
      );
    }
    if (format === 'pdf') {
      const stats = tournamentStats(tournamentId, tiebreakers);
      const buffer = renderTablePdf({
        title: tournament.name,
        subtitle: `${title}  |  ${tournament.game}`,
        meta: [
          `${stats.teams} teams  -  ${stats.completed}/${stats.matches} matches played`,
          tournament.start_date ? `Starts ${tournament.start_date}` : '',
          `Exported ${stamp}`,
        ].filter(Boolean),
        columns,
        rows,
        footerNote: `${tournament.name} - ${title}`,
      });
      return sendFileDownload(ctx.res, `${base}.pdf`, buffer, PDF_MIME);
    }
    throw badRequest(`Unknown format ".${format}". Use csv, xlsx, pdf or json.`);
  });
}

/** Renders one cell consistently across CSV / XLSX / PDF. */
function cellValue(row, column) {
  const value = column.get ? column.get(row) : row[column.key];
  if (value === null || value === undefined) return '';
  return value;
}

function fullBackup(tournamentId, tournament, settingsRow) {
  const q = (sql) => all(sql, [tournamentId]);
  return {
    exported_at: new Date().toISOString(),
    tournament,
    settings: expandSettings(settingsRow),
    stages: q('SELECT * FROM stages WHERE tournament_id = ?'),
    groups: q('SELECT * FROM groups WHERE tournament_id = ?'),
    rounds: q('SELECT * FROM rounds WHERE tournament_id = ?'),
    teams: q('SELECT * FROM teams WHERE tournament_id = ?'),
    players: all('SELECT p.* FROM players p JOIN teams t ON t.id = p.team_id WHERE t.tournament_id = ?', [tournamentId]),
    matches: q('SELECT * FROM matches WHERE tournament_id = ?'),
    match_participants: all(
      'SELECT mp.* FROM match_participants mp JOIN matches m ON m.id = mp.match_id WHERE m.tournament_id = ?',
      [tournamentId],
    ),
    match_results: all(
      'SELECT r.* FROM match_results r JOIN matches m ON m.id = r.match_id WHERE m.tournament_id = ?',
      [tournamentId],
    ),
    qualifications: q('SELECT * FROM qualifications WHERE tournament_id = ?'),
    audit_logs: q('SELECT * FROM audit_logs WHERE tournament_id = ?'),
  };
}

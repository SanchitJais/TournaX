/** Team + player management, including Excel/CSV bulk import. */
import { all, get, insert, run, tx, updateRow } from '../db.js';
import { requireAbility } from '../auth.js';
import { badRequest, conflict, notFound, saveDataUrl } from '../lib/http.js';
import { normaliseHeader, parseCsvObjects } from '../lib/csv.js';
import { readXlsxObjects } from '../lib/xlsx.js';
import { recordAudit } from '../services/audit.js';
import { distributeGroups, makeRng } from '../services/fixtures.js';
import { loadTournament } from './tournaments.js';

const TEAM_FIELDS = [
  'name', 'tag', 'team_code', 'logo_url', 'captain_name', 'captain_contact',
  'group_id', 'seed', 'status', 'notes',
];

export function teamWithPlayers(id) {
  const team = get(
    `SELECT t.*, g.name AS group_name FROM teams t
       LEFT JOIN groups g ON g.id = t.group_id WHERE t.id = ?`,
    [id],
  );
  if (!team) return null;
  return { ...team, players: all('SELECT * FROM players WHERE team_id = ? ORDER BY order_index, id', [id]) };
}

function replacePlayers(teamId, players) {
  run('DELETE FROM players WHERE team_id = ?', [teamId]);
  (players || []).forEach((player, i) => {
    const name = String(player?.name ?? player ?? '').trim();
    if (!name) return;
    insert(
      'INSERT INTO players (team_id, name, in_game_id, role, is_captain, order_index) VALUES (?, ?, ?, ?, ?, ?)',
      [teamId, name.slice(0, 80), player?.in_game_id || null, player?.role || null, player?.is_captain ? 1 : 0, i],
    );
  });
}

export default function register(router) {
  router.get('/api/tournaments/:id/teams', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    const { search = '', group = '', status = '' } = ctx.query;

    const where = ['t.tournament_id = ?'];
    const params = [tournamentId];
    if (search) {
      where.push('(t.name LIKE ? OR t.tag LIKE ? OR t.team_code LIKE ? OR t.captain_name LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    if (group) { where.push('t.group_id = ?'); params.push(Number(group)); }
    if (status) { where.push('t.status = ?'); params.push(status); }

    const teams = all(
      `SELECT t.*, g.name AS group_name FROM teams t
         LEFT JOIN groups g ON g.id = t.group_id
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(t.seed, 9999), t.name`,
      params,
    );
    const players = all(
      `SELECT p.* FROM players p JOIN teams t ON t.id = p.team_id
        WHERE t.tournament_id = ? ORDER BY p.order_index, p.id`,
      [tournamentId],
    );
    const byTeam = new Map();
    for (const p of players) {
      if (!byTeam.has(p.team_id)) byTeam.set(p.team_id, []);
      byTeam.get(p.team_id).push(p);
    }
    return {
      teams: teams.map((t) => ({ ...t, players: byTeam.get(t.id) || [] })),
      groups: all('SELECT * FROM groups WHERE tournament_id = ? ORDER BY order_index, name', [tournamentId]),
    };
  });

  router.post('/api/tournaments/:id/teams', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'teams:write', tournamentId);
    loadTournament(tournamentId);

    const name = String(ctx.body.name || '').trim();
    if (!name) throw badRequest('A team needs a name.');
    if (get('SELECT id FROM teams WHERE tournament_id = ? AND name = ?', [tournamentId, name])) {
      throw conflict(`A team called "${name}" is already registered.`);
    }

    const id = tx(() => {
      const teamId = insert(
        `INSERT INTO teams (tournament_id, name, tag, team_code, logo_url, captain_name, captain_contact, group_id, seed, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tournamentId, name, ctx.body.tag || null, ctx.body.team_code || null,
          saveDataUrl(ctx.body.logo_url, 'team'), ctx.body.captain_name || null,
          ctx.body.captain_contact || null,
          ctx.body.group_id ? Number(ctx.body.group_id) : null,
          ctx.body.seed ? Number(ctx.body.seed) : null,
          ctx.body.status || 'active', ctx.body.notes || null,
        ],
      );
      replacePlayers(teamId, ctx.body.players);
      return teamId;
    });

    recordAudit({
      tournamentId, actor: ctx.user, action: 'team.created', entity: 'team', entityId: id,
      summary: `Added team "${name}".`,
    });
    return { __status: 201, team: teamWithPlayers(id) };
  });

  router.patch('/api/teams/:id', (ctx) => {
    const id = Number(ctx.params.id);
    const before = get('SELECT * FROM teams WHERE id = ?', [id]);
    if (!before) throw notFound('Team not found');
    requireAbility(ctx, 'teams:write', before.tournament_id);

    if (ctx.body.name && ctx.body.name !== before.name) {
      const clash = get('SELECT id FROM teams WHERE tournament_id = ? AND name = ? AND id != ?', [before.tournament_id, ctx.body.name, id]);
      if (clash) throw conflict(`Another team is already called "${ctx.body.name}".`);
    }

    const fields = { ...ctx.body };
    if (fields.logo_url) fields.logo_url = saveDataUrl(fields.logo_url, 'team');
    if (fields.group_id === '' || fields.group_id === null) fields.group_id = null;
    else if (fields.group_id !== undefined) fields.group_id = Number(fields.group_id);
    if (fields.seed === '' || fields.seed === null) fields.seed = null;

    tx(() => {
      updateRow('teams', id, fields, TEAM_FIELDS);
      if (ctx.body.players !== undefined) replacePlayers(id, ctx.body.players);
    });

    recordAudit({
      tournamentId: before.tournament_id, actor: ctx.user, action: 'team.updated', entity: 'team', entityId: id,
      summary: `Updated team "${before.name}".`, before, after: get('SELECT * FROM teams WHERE id = ?', [id]),
    });
    return { team: teamWithPlayers(id) };
  });

  router.delete('/api/teams/:id', (ctx) => {
    const id = Number(ctx.params.id);
    const team = get('SELECT * FROM teams WHERE id = ?', [id]);
    if (!team) throw notFound('Team not found');
    requireAbility(ctx, 'teams:write', team.tournament_id);

    const played = get(
      `SELECT COUNT(*) AS n FROM match_results r JOIN matches m ON m.id = r.match_id
        WHERE r.team_id = ? AND m.status = 'completed'`,
      [id],
    ).n;

    run('DELETE FROM teams WHERE id = ?', [id]);
    recordAudit({
      tournamentId: team.tournament_id, actor: ctx.user, action: 'team.deleted', entity: 'team', entityId: id,
      summary: `Removed team "${team.name}"${played ? ` along with ${played} recorded result(s)` : ''}.`,
      before: team,
    });
    return { ok: true, removed_results: played };
  });

  /** Spread teams over the stage's groups, seeded or drawn at random. */
  router.post('/api/tournaments/:id/teams/assign-groups', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'teams:write', tournamentId);
    const tournament = loadTournament(tournamentId);

    const stageId = ctx.body.stage_id
      ? Number(ctx.body.stage_id)
      : get('SELECT id FROM stages WHERE tournament_id = ? ORDER BY order_index LIMIT 1', [tournamentId])?.id;
    const numGroups = Math.max(1, Number(ctx.body.num_groups) || tournament.num_groups || 1);
    const teams = all('SELECT * FROM teams WHERE tournament_id = ? ORDER BY COALESCE(seed, 9999), name', [tournamentId]);
    if (!teams.length) throw badRequest('Add teams first.');

    const buckets = distributeGroups(teams, numGroups, {
      seeded: ctx.body.seeded !== false,
      rng: makeRng(ctx.body.seed ?? null),
    });

    tx(() => {
      run('UPDATE teams SET group_id = NULL WHERE tournament_id = ?', [tournamentId]);
      run('DELETE FROM groups WHERE tournament_id = ? AND (stage_id = ? OR stage_id IS NULL)', [tournamentId, stageId]);
      buckets.forEach((members, i) => {
        const groupId = insert(
          'INSERT INTO groups (tournament_id, stage_id, name, order_index) VALUES (?, ?, ?, ?)',
          [tournamentId, stageId ?? null, `Group ${String.fromCharCode(65 + i)}`, i],
        );
        for (const team of members) run('UPDATE teams SET group_id = ? WHERE id = ?', [groupId, team.id]);
      });
    });

    recordAudit({
      tournamentId, actor: ctx.user, action: 'teams.grouped', entity: 'tournament', entityId: tournamentId,
      summary: `Distributed ${teams.length} teams across ${numGroups} group(s).`,
    });
    return {
      groups: all('SELECT * FROM groups WHERE tournament_id = ? ORDER BY order_index', [tournamentId]),
      teams: all('SELECT id, name, group_id FROM teams WHERE tournament_id = ?', [tournamentId]),
    };
  });

  /** Bulk import from parsed rows, raw CSV text, or an uploaded .csv/.xlsx. */
  router.post('/api/tournaments/:id/teams/import', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'teams:write', tournamentId);
    loadTournament(tournamentId);

    const rows = extractRows(ctx.body);
    if (!rows.length) throw badRequest('No rows found in that file.');

    const mode = ctx.body.mode === 'replace' ? 'replace' : 'merge';
    const report = { created: 0, updated: 0, skipped: [], groups: 0 };

    tx(() => {
      if (mode === 'replace') run('DELETE FROM teams WHERE tournament_id = ?', [tournamentId]);

      const groupCache = new Map(
        all('SELECT id, name FROM groups WHERE tournament_id = ?', [tournamentId])
          .map((g) => [g.name.toLowerCase(), g.id]),
      );
      const stageId = get('SELECT id FROM stages WHERE tournament_id = ? ORDER BY order_index LIMIT 1', [tournamentId])?.id ?? null;

      rows.forEach((raw, index) => {
        const parsed = mapTeamRow(raw);
        if (!parsed.name) {
          report.skipped.push({ row: index + 2, reason: 'No team name in this row' });
          return;
        }

        let groupId = null;
        if (parsed.group) {
          const key = parsed.group.toLowerCase();
          if (!groupCache.has(key)) {
            groupCache.set(key, insert(
              'INSERT INTO groups (tournament_id, stage_id, name, order_index) VALUES (?, ?, ?, ?)',
              [tournamentId, stageId, parsed.group, groupCache.size],
            ));
            report.groups++;
          }
          groupId = groupCache.get(key);
        }

        const existing = get('SELECT * FROM teams WHERE tournament_id = ? AND name = ?', [tournamentId, parsed.name]);
        if (existing) {
          updateRow('teams', existing.id, {
            tag: parsed.tag ?? existing.tag,
            team_code: parsed.team_code ?? existing.team_code,
            captain_name: parsed.captain_name ?? existing.captain_name,
            captain_contact: parsed.captain_contact ?? existing.captain_contact,
            seed: parsed.seed ?? existing.seed,
            group_id: groupId ?? existing.group_id,
          }, TEAM_FIELDS);
          if (parsed.players.length) replacePlayers(existing.id, parsed.players);
          report.updated++;
          return;
        }

        const teamId = insert(
          `INSERT INTO teams (tournament_id, name, tag, team_code, captain_name, captain_contact, group_id, seed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            tournamentId, parsed.name, parsed.tag, parsed.team_code,
            parsed.captain_name, parsed.captain_contact, groupId, parsed.seed,
          ],
        );
        replacePlayers(teamId, parsed.players);
        report.created++;
      });
    });

    recordAudit({
      tournamentId, actor: ctx.user, action: 'teams.imported', entity: 'tournament', entityId: tournamentId,
      summary: `Imported teams: ${report.created} added, ${report.updated} updated, ${report.skipped.length} skipped.`,
    });
    return report;
  });

  /** A ready-made import sheet, so the organizer knows the expected columns. */
  router.get('/api/import-template', () => ({
    headers: [
      'Team Name', 'Tag', 'Team ID', 'Captain Name', 'Captain Contact', 'Group', 'Seed',
      'Player 1', 'Player 1 IGN', 'Player 2', 'Player 2 IGN', 'Player 3', 'Player 3 IGN',
      'Player 4', 'Player 4 IGN', 'Player 5', 'Player 5 IGN',
    ],
    example: [
      'Soul Esports', 'SOUL', 'T-001', 'Mortal', 'mortal@example.com', 'A', '1',
      'Owais', '5123456789', 'Viper', '5123456790', 'Regaltos', '5123456791',
      'Hector', '5123456792', '', '',
    ],
  }));
}

// ------------------------------------------------------------ import helpers --
function extractRows(body) {
  if (Array.isArray(body.rows) && body.rows.length) return body.rows;
  if (body.csv) return parseCsvObjects(String(body.csv));

  if (body.file?.data) {
    const buffer = Buffer.from(String(body.file.data).replace(/^data:[^,]*,/, ''), 'base64');
    const name = String(body.file.name || '').toLowerCase();
    if (name.endsWith('.xlsx') || buffer.subarray(0, 2).toString() === 'PK') {
      try {
        return readXlsxObjects(buffer, normaliseHeader);
      } catch (err) {
        throw badRequest(`That .xlsx file could not be read: ${err.message}`);
      }
    }
    return parseCsvObjects(buffer.toString('utf8'));
  }
  return [];
}

/** Accepts the many shapes organizers actually use for their team sheets. */
export function mapTeamRow(raw) {
  const row = {};
  for (const [key, value] of Object.entries(raw || {})) {
    row[normaliseHeader(key)] = typeof value === 'string' ? value.trim() : value;
  }
  const pick = (...keys) => {
    for (const key of keys) {
      const value = row[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
    }
    return null;
  };

  const players = [];
  for (let i = 1; i <= 8; i++) {
    const name = pick(`player_${i}`, `player${i}`, `p${i}`, `player_${i}_name`);
    const ign = pick(`player_${i}_ign`, `player_${i}_id`, `player${i}_id`, `p${i}_id`, `player_${i}_ingame_id`);
    if (name) players.push({ name, in_game_id: ign, is_captain: i === 1 && !pick('captain', 'captain_name') });
  }
  // A single "Players" column holding a comma/slash separated list.
  if (!players.length) {
    const blob = pick('players', 'player_names', 'roster', 'squad');
    if (blob) {
      for (const part of blob.split(/[,;/|]/)) {
        const name = part.trim();
        if (name) players.push({ name, in_game_id: null, is_captain: false });
      }
    }
  }

  const seedRaw = pick('seed', 'seeding', 'rank');
  const seed = seedRaw !== null && Number.isFinite(Number(seedRaw)) ? Number(seedRaw) : null;

  return {
    name: pick('team_name', 'team', 'name', 'teamname', 'squad_name', 'clan'),
    tag: pick('tag', 'short_name', 'abbr', 'abbreviation', 'team_tag'),
    team_code: pick('team_id', 'team_code', 'code', 'id', 'registration_id'),
    captain_name: pick('captain_name', 'captain', 'leader', 'igl'),
    captain_contact: pick('captain_contact', 'contact', 'phone', 'mobile', 'email', 'captain_email', 'whatsapp'),
    group: pick('group', 'group_name', 'pool', 'lobby'),
    seed,
    players,
  };
}

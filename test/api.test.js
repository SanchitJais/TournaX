/**
 * End-to-end API test: boots a real server against a throwaway database and
 * walks the organizer's whole workflow, from creating a tournament through to
 * generating the grand final.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(os.tmpdir(), `tms-test-${process.pid}-${Date.now()}.db`);
const PORT = 3400 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let cookie = '';

async function api(method, url, body, { raw = false } = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  for (const c of setCookie) {
    const pair = c.split(';')[0];
    if (pair.startsWith('tms_session=')) cookie = pair;
  }
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH, QUIET: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/meta`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 120));
  }
});

test.after(() => {
  child?.kill();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${DB_PATH}${suffix}`); } catch { /* already gone */ }
  }
});

/** Run one request signed out, restoring the session even if it throws. */
async function asAnonymous(fn) {
  const saved = cookie;
  cookie = '';
  try {
    return await fn();
  } finally {
    cookie = saved;
  }
}

/** Stored timestamps are naive local time, matching what the UI sends. */
const pad = (n) => String(n).padStart(2, '0');
function localStamp(offsetMs = 0) {
  const d = new Date(Date.now() + offsetMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------

let tournamentId;
let stageId;
const teamIds = [];

test('first registered account becomes the super admin', async () => {
  const res = await api('POST', '/api/auth/register', {
    email: 'boss@example.com', name: 'Boss', password: 'supersecret1',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.first, true);
  assert.equal(res.body.user.role, 'super_admin');
  assert.ok(cookie, 'a session cookie should be set');
});

test('anonymous requests cannot create a tournament', async () => {
  const saved = cookie;
  cookie = '';
  const res = await api('POST', '/api/tournaments', { name: 'Sneaky Cup' });
  assert.equal(res.status, 401);
  cookie = saved;
});

test('creates a tournament with scoring and qualification rules', async () => {
  const res = await api('POST', '/api/tournaments', {
    name: 'Test Championship',
    game: 'BGMI',
    format_type: 'battle_royale',
    num_teams: 16, num_groups: 1, num_rounds: 1, matches_per_round: 4, teams_per_match: 16,
    start_date: '2026-10-01',
    settings: {
      qualification: { mode: 'top_overall', count: 4 },
      schedule_options: { firstMatchTime: '18:00', matchGapMinutes: 30, matchesPerDay: 4 },
    },
  });
  assert.equal(res.status, 201);
  tournamentId = res.body.tournament.id;
  assert.equal(res.body.tournament.slug, 'test-championship');

  const bundle = await api('GET', `/api/tournaments/${tournamentId}`);
  assert.equal(bundle.body.settings.qualification.count, 4);
  assert.equal(bundle.body.stages.length, 1, 'a first stage is created automatically');
  stageId = bundle.body.stages[0].id;
});

test('imports teams from CSV, mapping varied column names', async () => {
  const csv = [
    'Team Name,Tag,Team ID,Captain,Group,Seed,Player 1,Player 1 IGN,Player 2',
    ...Array.from({ length: 16 }, (_, i) =>
      `Squad ${i + 1},S${i + 1},T-${i + 1},Captain ${i + 1},A,${i + 1},Player A${i + 1},51234${i},Player B${i + 1}`),
  ].join('\n');

  const res = await api('POST', `/api/tournaments/${tournamentId}/teams/import`, { csv });
  assert.equal(res.status, 200);
  assert.equal(res.body.created, 16);
  assert.equal(res.body.skipped.length, 0);

  const list = await api('GET', `/api/tournaments/${tournamentId}/teams`);
  assert.equal(list.body.teams.length, 16);
  const first = list.body.teams.find((t) => t.name === 'Squad 1');
  assert.equal(first.team_code, 'T-1');
  assert.equal(first.captain_name, 'Captain 1');
  assert.equal(first.players.length, 2);
  assert.equal(first.players[0].in_game_id, '512340');
  list.body.teams.forEach((t) => teamIds.push(t.id));
});

test('re-importing the same sheet updates instead of duplicating', async () => {
  const csv = 'Team Name,Captain\nSquad 1,New Captain';
  const res = await api('POST', `/api/tournaments/${tournamentId}/teams/import`, { csv });
  assert.equal(res.body.created, 0);
  assert.equal(res.body.updated, 1);
  const list = await api('GET', `/api/tournaments/${tournamentId}/teams?search=Squad 1`);
  assert.equal(list.body.teams[0].captain_name, 'New Captain');
});

test('imports teams from a real .xlsx upload', async () => {
  const { buildXlsx } = await import('../src/lib/xlsx.js');
  const workbook = buildXlsx([{
    name: 'Teams',
    headers: ['Team Name', 'Tag', 'Captain Name', 'Group', 'Player 1', 'Player 1 IGN'],
    rows: [
      ['Excel Squad One', 'EX1', 'Riya', 'B', 'Nova', '9001'],
      ['Excel Squad Two', 'EX2', 'Kabir', 'B', 'Rex', '9002'],
    ],
  }]);

  const res = await api('POST', `/api/tournaments/${tournamentId}/teams/import`, {
    file: { name: 'teams.xlsx', data: workbook.toString('base64') },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.created, 2);
  assert.equal(res.body.groups, 1, 'group B is created from the sheet');

  const list = await api('GET', `/api/tournaments/${tournamentId}/teams?search=Excel Squad One`);
  const team = list.body.teams[0];
  assert.equal(team.tag, 'EX1');
  assert.equal(team.captain_name, 'Riya');
  assert.equal(team.group_name, 'B');
  assert.equal(team.players[0].in_game_id, '9001');

  // Clean up so later counts stay predictable.
  for (const name of ['Excel Squad One', 'Excel Squad Two']) {
    const found = await api('GET', `/api/tournaments/${tournamentId}/teams?search=${encodeURIComponent(name)}`);
    if (found.body.teams[0]) await api('DELETE', `/api/teams/${found.body.teams[0].id}`);
  }
});

test('a corrupt spreadsheet is rejected with a readable message', async () => {
  const res = await api('POST', `/api/tournaments/${tournamentId}/teams/import`, {
    file: { name: 'broken.xlsx', data: Buffer.from('PKnot-really-a-zip').toString('base64') },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /could not be read|No rows/i);
});

test('rejects a duplicate team name', async () => {
  const res = await api('POST', `/api/tournaments/${tournamentId}/teams`, { name: 'Squad 1' });
  assert.equal(res.status, 409);
});

test('previewing fixtures does not write anything', async () => {
  const before = await api('GET', `/api/tournaments/${tournamentId}/matches`);
  const preview = await api('POST', `/api/stages/${stageId}/fixtures/preview`, {});
  assert.equal(preview.status, 200);
  assert.equal(preview.body.matches.length, 4);
  assert.equal(preview.body.matches[0].teams.length, 16);
  const after = await api('GET', `/api/tournaments/${tournamentId}/matches`);
  assert.equal(after.body.matches.length, before.body.matches.length);
});

test('generates fixtures automatically', async () => {
  const res = await api('POST', `/api/stages/${stageId}/fixtures/generate`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.matches, 4);

  const list = await api('GET', `/api/tournaments/${tournamentId}/matches`);
  const matches = list.body.matches;
  assert.equal(matches.length, 4);
  assert.deepEqual(matches.map((m) => m.match_no), [1, 2, 3, 4]);
  assert.equal(matches[0].teams.length, 16);
  assert.equal(matches[0].scheduled_at, '2026-10-01 18:00');
  assert.equal(matches[1].scheduled_at, '2026-10-01 18:30');
  assert.equal(matches[0].status, 'upcoming');
});

test('regenerating replaces the previous schedule', async () => {
  const res = await api('POST', `/api/stages/${stageId}/fixtures/generate`, {});
  assert.equal(res.status, 200);
  const list = await api('GET', `/api/tournaments/${tournamentId}/matches`);
  assert.equal(list.body.matches.length, 4, 'should replace, not append');
});

test('room credentials stay hidden until their reveal time', async () => {
  const list = await api('GET', `/api/tournaments/${tournamentId}/matches`);
  const matchId = list.body.matches[0].id;

  await api('POST', `/api/tournaments/${tournamentId}/matches/credentials`, {
    entries: [{
      match_id: matchId,
      room_id: '998877',
      room_password: 'letmein',
      credentials_reveal_at: localStamp(3600_000),
    }],
  });

  // The organizer always sees them.
  const asAdmin = await api('GET', `/api/matches/${matchId}`);
  assert.equal(asAdmin.body.match.room_id, '998877');

  // The public does not, until the time passes.
  const hidden = await asAnonymous(() => api('GET', '/api/public/t/test-championship/matches'));
  const publicMatch = hidden.body.matches.find((m) => m.id === matchId);
  assert.equal(publicMatch.room_id, null);
  assert.equal(publicMatch.credentials.revealed, false);

  // Move the reveal into the past and it opens up.
  await api('PATCH', `/api/matches/${matchId}`, { credentials_reveal_at: localStamp(-60_000) });
  const shown = await asAnonymous(() => api('GET', '/api/public/t/test-championship/matches'));
  assert.equal(shown.body.matches.find((m) => m.id === matchId).room_id, '998877');
});

test('entering results computes every point column automatically', async () => {
  const list = await api('GET', `/api/tournaments/${tournamentId}/matches`);
  const match = list.body.matches[0];

  const entries = match.teams.map((t, i) => ({
    team_id: t.team_id,
    placement: i + 1,
    kills: 16 - i,
    // Deliberately send no point columns -- the server must derive them.
    bonus_points: i === 0 ? 2 : 0,
    penalty_points: i === 1 ? 5 : 0,
  }));

  const res = await api('PUT', `/api/matches/${match.id}/results`, { entries, status: 'completed' });
  assert.equal(res.status, 200);

  const results = res.body.match.results;
  const winner = results.find((r) => r.placement === 1);
  // BGMI default: 1st = 10 placement points, 1 point per kill.
  assert.equal(winner.placement_points, 10);
  assert.equal(winner.kill_points, 16);
  assert.equal(winner.bonus_points, 2);
  assert.equal(winner.total_points, 28, '10 + 16 + 2 - 0');
  assert.equal(winner.is_win, 1);

  const second = results.find((r) => r.placement === 2);
  assert.equal(second.placement_points, 6);
  assert.equal(second.kill_points, 15);
  assert.equal(second.penalty_points, 5);
  assert.equal(second.total_points, 16, '6 + 15 + 0 - 5');
});

test('duplicate placements are rejected', async () => {
  const list = await api('GET', `/api/tournaments/${tournamentId}/matches`);
  const match = list.body.matches[1];
  const res = await api('PUT', `/api/matches/${match.id}/results`, {
    entries: [
      { team_id: match.teams[0].team_id, placement: 1, kills: 3 },
      { team_id: match.teams[1].team_id, placement: 1, kills: 2 },
    ],
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Placement #1/);
});

test('a team that is not in the match cannot be scored', async () => {
  const list = await api('GET', `/api/tournaments/${tournamentId}/matches`);
  const match = list.body.matches[1];
  const outsider = 999999;
  const res = await api('PUT', `/api/matches/${match.id}/results`, {
    entries: [{ team_id: outsider, placement: 1, kills: 1 }],
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not playing/);
});

test('the leaderboard updates itself and ranks by the configured tiebreakers', async () => {
  const res = await api('GET', `/api/tournaments/${tournamentId}/leaderboard`);
  const standings = res.body.standings;
  assert.equal(standings.length, 16);
  assert.equal(standings[0].rank, 1);
  assert.equal(standings[0].total_points, 28);
  assert.equal(standings[0].matches_played, 1);
  assert.equal(standings[0].wins, 1);
  assert.equal(standings[0].total_kills, 16);

  // Sorted descending by total points.
  for (let i = 1; i < standings.length; i++) {
    assert.ok(standings[i - 1].total_points >= standings[i].total_points, 'standings must be ordered');
  }
});

test('editing a result immediately rewrites the standings', async () => {
  const list = await api('GET', `/api/tournaments/${tournamentId}/matches`);
  const match = list.body.matches[0];
  const before = await api('GET', `/api/tournaments/${tournamentId}/leaderboard`);
  const leaderId = before.body.standings[0].team_id;

  // Hand the win to whoever finished last instead.
  const flipped = match.teams.map((t, i) => ({
    team_id: t.team_id,
    placement: match.teams.length - i,
    kills: 1,
  }));
  await api('PUT', `/api/matches/${match.id}/results`, { entries: flipped, status: 'completed' });

  const after = await api('GET', `/api/tournaments/${tournamentId}/leaderboard`);
  assert.notEqual(after.body.standings[0].team_id, leaderId, 'the leader should have changed');
  assert.equal(after.body.standings[0].total_points, 11, '10 placement + 1 kill');
});

test('qualification is computed live from the standings', async () => {
  const res = await api('GET', `/api/stages/${stageId}/qualification`);
  assert.equal(res.status, 200);
  assert.equal(res.body.config.count, 4);
  assert.equal(res.body.qualified.length, 4);
  assert.equal(res.body.eliminated.length, 12);
  assert.equal(res.body.qualified[0].rank, 1);
});

test('locking qualification stamps team status and records an audit entry', async () => {
  const res = await api('POST', `/api/stages/${stageId}/qualification/lock`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.qualified.length, 4);

  const teams = await api('GET', `/api/tournaments/${tournamentId}/teams?status=qualified`);
  assert.equal(teams.body.teams.length, 4);

  const audit = await api('GET', `/api/tournaments/${tournamentId}/audit`);
  assert.ok(audit.body.entries.some((e) => e.action === 'qualification.locked'));
});

test('"generate next round" carries the qualified teams into a new stage', async () => {
  const res = await api('POST', `/api/stages/${stageId}/next`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.stage.kind, 'grand_final');
  assert.equal(res.body.teams.length, 4);

  const bundle = await api('GET', `/api/tournaments/${tournamentId}`);
  assert.equal(bundle.body.stages.length, 2);

  // The new stage's matches contain exactly the four qualified teams.
  const matches = await api('GET', `/api/tournaments/${tournamentId}/matches?stage=${res.body.stage.id}`);
  assert.ok(matches.body.matches.length > 0);
  assert.equal(matches.body.matches[0].teams.length, 4);

  // Match numbering stays continuous across the whole tournament.
  const allMatches = await api('GET', `/api/tournaments/${tournamentId}/matches`);
  const numbers = allMatches.body.matches.map((m) => m.match_no);
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1));
});

test('cannot advance a stage that has no qualified teams', async () => {
  const bundle = await api('GET', `/api/tournaments/${tournamentId}`);
  const finalStage = bundle.body.stages[1];
  const res = await api('POST', `/api/stages/${finalStage.id}/next`, {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Lock qualification/);
});

test('exports produce real CSV, XLSX and PDF files', async () => {
  const csv = await api('GET', `/api/tournaments/${tournamentId}/export/leaderboard.csv`, null, { raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const csvText = await csv.text();
  assert.ok(csvText.includes('Team'), 'has a header row');
  assert.equal(csvText.trim().split('\n').length, 17, '16 teams plus the header');

  const xlsx = await api('GET', `/api/tournaments/${tournamentId}/export/teams.xlsx`, null, { raw: true });
  const xlsxBuf = Buffer.from(await xlsx.arrayBuffer());
  assert.equal(xlsxBuf.subarray(0, 2).toString(), 'PK');

  const pdf = await api('GET', `/api/tournaments/${tournamentId}/export/schedule.pdf`, null, { raw: true });
  const pdfBuf = Buffer.from(await pdf.arrayBuffer());
  assert.equal(pdfBuf.subarray(0, 5).toString(), '%PDF-');

  const backup = await api('GET', `/api/tournaments/${tournamentId}/export/tournament.json`, null, { raw: true });
  const data = await backup.json();
  assert.equal(data.teams.length, 16);
  assert.ok(data.match_results.length > 0);
});

test('the public page hides captain contact details', async () => {
  const res = await asAnonymous(() => api('GET', '/api/public/t/test-championship/teams'));
  assert.equal(res.status, 200);
  assert.equal(res.body.teams.length, 16);
  assert.ok(!('captain_contact' in res.body.teams[0]), 'contact details must not be public');
});

test('a scorekeeper can score but cannot edit the tournament', async () => {
  await api('POST', `/api/tournaments/${tournamentId}/members`, {
    email: 'scorer@example.com', name: 'Scorer', password: 'scorer12345', role: 'scorekeeper',
  });

  const adminCookie = cookie;
  try {
    cookie = '';
    await api('POST', '/api/auth/login', { email: 'scorer@example.com', password: 'scorer12345' });

    const abilities = await api('GET', `/api/tournaments/${tournamentId}/abilities`);
    assert.equal(abilities.body.role, 'scorekeeper');
    assert.equal(abilities.body.abilities['results:write'], true);
    assert.equal(abilities.body.abilities['tournament:write'], false);

    const denied = await api('PATCH', `/api/tournaments/${tournamentId}`, { name: 'Hijacked' });
    assert.equal(denied.status, 403);

    const deniedTeams = await api('POST', `/api/tournaments/${tournamentId}/teams`, { name: 'Rogue' });
    assert.equal(deniedTeams.status, 403);
  } finally {
    cookie = adminCookie;
  }
});

test('audit history records who changed what', async () => {
  const res = await api('GET', `/api/tournaments/${tournamentId}/audit`);
  const actions = res.body.entries.map((e) => e.action);
  for (const expected of ['tournament.created', 'teams.imported', 'fixtures.generated', 'result.updated', 'qualification.locked']) {
    assert.ok(actions.includes(expected), `expected an audit entry for ${expected}`);
  }
  const resultEdit = res.body.entries.find((e) => e.action === 'result.updated');
  assert.ok(resultEdit.before, 'stores the previous values');
  assert.ok(resultEdit.after);
  assert.ok(resultEdit.actor_name);
});

test('notifications are raised for the events organizers care about', async () => {
  const res = await api('GET', `/api/tournaments/${tournamentId}/notifications`);
  const types = res.body.notifications.map((n) => n.type);
  assert.ok(types.includes('match.completed') || types.includes('results.published'));
  assert.ok(types.includes('team.qualified'));
  assert.ok(res.body.unread > 0);

  await api('POST', `/api/tournaments/${tournamentId}/notifications/read-all`);
  const after = await api('GET', `/api/tournaments/${tournamentId}/notifications`);
  assert.equal(after.body.unread, 0);
});

test('the dashboard returns every card in one request', async () => {
  const res = await api('GET', `/api/tournaments/${tournamentId}/dashboard`);
  const { stats } = res.body;
  assert.equal(stats.teams, 16);
  assert.ok(stats.matches > 0);
  assert.ok(stats.leader);
  assert.equal(stats.qualified, 4);
  assert.ok(Array.isArray(res.body.upcoming));
  assert.ok(Array.isArray(res.body.standings));
});

test('unknown API routes return a JSON 404', async () => {
  const res = await api('GET', '/api/nope');
  assert.equal(res.status, 404);
  assert.match(res.body.error, /No API route/);
});

test('client-side routes fall through to the app shell', async () => {
  const res = await fetch(`${BASE}/t/test-championship`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

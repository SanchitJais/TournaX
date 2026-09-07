/**
 * End-to-end tests for the platform tier: profiles, teams, invitations,
 * registration, approval, check-in, penalties, scoring presets, per-player
 * stats, search and discovery.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(os.tmpdir(), `tms-platform-${process.pid}-${Date.now()}.db`);
const PORT = 3700 + (process.pid % 250);
const BASE = `http://127.0.0.1:${PORT}`;

let child;
/** name -> cookie, so several users can be driven in one test run. */
const sessions = new Map();
let current = 'organizer';

async function api(method, url, body, { raw = false, as = null } = {}) {
  const who = as || current;
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(sessions.get(who) ? { Cookie: sessions.get(who) } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    const pair = c.split(';')[0];
    if (pair.startsWith('tms_session=')) sessions.set(who, pair);
  }
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

const as = (who, fn) => { const prev = current; current = who; return Promise.resolve(fn()).finally(() => { current = prev; }); };

async function signUp(who, email, name, password = 'password1234') {
  current = who;
  const res = await api('POST', '/api/auth/register', { email, name, password });
  assert.ok(res.status === 200, `sign-up failed for ${who}: ${JSON.stringify(res.body)}`);
  return res.body.user;
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
    try { if ((await fetch(`${BASE}/api/meta`)).ok) break; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 120));
  }
});

test.after(() => {
  child?.kill();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${DB_PATH}${suffix}`); } catch { /* gone */ }
  }
});

// ---------------------------------------------------------------------------
let tournamentId;
let tournamentSlug;
let squadA;
let squadB;
const users = {};

test('the first account becomes super admin; later accounts are players', async () => {
  users.organizer = await signUp('organizer', 'org@example.com', 'Org Owner');
  assert.equal(users.organizer.role, 'super_admin');

  users.captain = await signUp('captain', 'cap@example.com', 'Cap Tain');
  assert.equal(users.captain.role, 'player', 'later sign-ups are players by default');

  users.player2 = await signUp('player2', 'p2@example.com', 'Second Player');
  users.rival = await signUp('rival', 'rival@example.com', 'Rival Captain');
});

test('google sign-in is advertised as unavailable until credentials are set', async () => {
  const res = await api('GET', '/api/auth/providers');
  assert.equal(res.body.google, false, 'not configured in this environment');
  assert.equal(res.body.password, true);

  const start = await api('GET', '/api/auth/google', null, { raw: true });
  assert.equal(start.status, 400, 'starting the flow fails cleanly rather than 500ing');
});

test('a profile is rejected until the three starred fields are present', async () => {
  await as('captain', async () => {
    const missing = await api('PUT', '/api/me/profile', { full_name: 'Cap Tain' });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /In-Game Name/);
    assert.match(missing.body.error, /Phone Number/);

    const badPhone = await api('PUT', '/api/me/profile', {
      full_name: 'Cap Tain', ign: 'CAPxGOD', phone: 'abc',
    });
    assert.equal(badPhone.status, 400);

    const ok = await api('PUT', '/api/me/profile', {
      full_name: 'Cap Tain', ign: 'CAPxGOD', in_game_id: '5123456789',
      phone: '+91 98765 43210', country: 'India', region: 'Maharashtra', discord: 'cap#1',
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.profile_complete, true);
    assert.equal(ok.body.profile.ign, 'CAPxGOD');
  });
});

test('players can complete their own profiles', async () => {
  for (const [who, ign] of [['player2', 'SecondIGN'], ['rival', 'RivalIGN'], ['organizer', 'OrgIGN']]) {
    await as(who, async () => {
      const res = await api('PUT', '/api/me/profile', {
        full_name: `${who} name`, ign, phone: '9876543210',
      });
      assert.equal(res.status, 200, `${who}: ${JSON.stringify(res.body)}`);
    });
  }
});

test('a captain creates a team and is its captain', async () => {
  await as('captain', async () => {
    const res = await api('POST', '/api/squads', { name: 'Alpha Wolves', tag: 'AW', game: 'BGMI', region: 'India' });
    assert.equal(res.status, 201);
    squadA = res.body.squad;
    assert.equal(res.body.members.length, 1);
    assert.equal(res.body.members[0].role, 'captain');
    assert.ok(squadA.slug, 'gets a shareable slug');
  });
});

test('duplicate team names are refused', async () => {
  await as('rival', async () => {
    const res = await api('POST', '/api/squads', { name: 'Alpha Wolves' });
    assert.equal(res.status, 409);
  });
});

test('invitations: send, appear for the invitee, accept, and join the roster', async () => {
  await as('captain', async () => {
    const res = await api('POST', `/api/squads/${squadA.id}/invites`, { email: 'p2@example.com', role: 'player' });
    assert.equal(res.status, 201);

    const dupe = await api('POST', `/api/squads/${squadA.id}/invites`, { email: 'p2@example.com' });
    assert.equal(dupe.status, 409, 'no duplicate pending invites');
  });

  await as('player2', async () => {
    const inbox = await api('GET', '/api/me/invites');
    assert.equal(inbox.body.invites.length, 1);
    assert.equal(inbox.body.invites[0].squad_name, 'Alpha Wolves');

    const accept = await api('POST', `/api/me/invites/${inbox.body.invites[0].id}`, { accept: true });
    assert.equal(accept.status, 200);
    assert.equal(accept.body.accepted, true);

    const mine = await api('GET', '/api/me');
    assert.equal(mine.body.squads.length, 1);
    assert.equal(mine.body.squads[0].name, 'Alpha Wolves');
  });

  const roster = await api('GET', `/api/squads/${squadA.id}/members`);
  assert.equal(roster.body.members.length, 2);
});

test('only the captain can manage the roster', async () => {
  await as('player2', async () => {
    const res = await api('POST', `/api/squads/${squadA.id}/invites`, { email: 'x@example.com' });
    assert.equal(res.status, 403);
  });
});

test('a player can leave, but the owner cannot abandon the team', async () => {
  await as('captain', async () => {
    const res = await api('POST', `/api/squads/${squadA.id}/leave`);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Transfer ownership/);
  });
});

test('organizer creates a tournament with registration settings', async () => {
  await as('organizer', async () => {
    const res = await api('POST', '/api/tournaments', {
      name: 'Platform Cup',
      game: 'BGMI',
      num_teams: 16, num_groups: 1, num_rounds: 1, matches_per_round: 4, teams_per_match: 16,
      start_date: '2026-12-01',
    });
    assert.equal(res.status, 201);
    tournamentId = res.body.tournament.id;
    tournamentSlug = res.body.tournament.slug;

    const configured = await api('PATCH', `/api/tournaments/${tournamentId}`, {
      keep_slug: true,
      registration_open: true,
      approval_mode: 'manual',
      slots: 4,
      min_players: 2,
      check_in_enabled: true,
      organizer_name: 'Org Owner',
      region: 'India',
      entry_requirements: 'Level 30+ account required.',
      rules_html: '<h2>Rules</h2><p>No emulators.</p><script>alert(1)</script>',
    });
    assert.equal(configured.status, 200);
    assert.equal(configured.body.tournament.approval_mode, 'manual');
    assert.ok(!configured.body.tournament.rules_html.includes('script'), 'rules are sanitised on write');
    assert.ok(configured.body.tournament.rules_html.includes('<h2>Rules</h2>'));
  });
});

test('registration is blocked when the team is too small', async () => {
  await as('organizer', () => api('PATCH', `/api/tournaments/${tournamentId}`, { keep_slug: true, min_players: 5 }));
  await as('captain', async () => {
    const res = await api('POST', `/api/tournaments/${tournamentId}/register`, { squad_id: squadA.id });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /at least 5 players/);
  });
  await as('organizer', () => api('PATCH', `/api/tournaments/${tournamentId}`, { keep_slug: true, min_players: 2 }));
});

test('a captain registers the team and it lands as pending under manual approval', async () => {
  await as('captain', async () => {
    const res = await api('POST', `/api/tournaments/${tournamentId}/register`, { squad_id: squadA.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.registration.status, 'pending');
  });

  await as('organizer', async () => {
    const list = await api('GET', `/api/tournaments/${tournamentId}/registrations`);
    assert.equal(list.body.counts.pending, 1);
    assert.equal(list.body.registrations[0].team_name, 'Alpha Wolves');
    assert.equal(list.body.registrations[0].roster.length, 2, 'roster snapshot is captured');
  });

  // Not approved yet, so no team exists in the tournament.
  const teams = await as('organizer', () => api('GET', `/api/tournaments/${tournamentId}/teams`));
  assert.equal(teams.body.teams.length, 0);
});

test('only the captain may register a team', async () => {
  await as('player2', async () => {
    const res = await api('POST', `/api/tournaments/${tournamentId}/register`, { squad_id: squadA.id });
    assert.equal(res.status, 403);
  });
});

test('approving a registration materialises the team and its players', async () => {
  await as('organizer', async () => {
    const list = await api('GET', `/api/tournaments/${tournamentId}/registrations`);
    const registration = list.body.registrations[0];

    const decided = await api('POST', `/api/tournaments/${tournamentId}/registrations/${registration.id}/decision`, { approve: true });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.registration.status, 'approved');
    assert.ok(decided.body.registration.team_id, 'a tournament team row was created');

    const teams = await api('GET', `/api/tournaments/${tournamentId}/teams`);
    assert.equal(teams.body.teams.length, 1);
    assert.equal(teams.body.teams[0].name, 'Alpha Wolves');
    assert.equal(teams.body.teams[0].players.length, 2, 'roster carried into the tournament');
    assert.equal(teams.body.teams[0].players[0].name, 'CAPxGOD', 'players are listed by IGN');
  });
});

test('a player cannot be in two teams in the same tournament', async () => {
  // The rival captain builds a team and poaches an already-registered player.
  await as('rival', async () => {
    const res = await api('POST', '/api/squads', { name: 'Rival Rangers', tag: 'RR' });
    squadB = res.body.squad;
    await api('POST', `/api/squads/${squadB.id}/invites`, { email: 'p2@example.com' });
  });
  await as('player2', async () => {
    const inbox = await api('GET', '/api/me/invites');
    await api('POST', `/api/me/invites/${inbox.body.invites[0].id}`, { accept: true });
  });

  await as('rival', async () => {
    const res = await api('POST', `/api/tournaments/${tournamentId}/register`, { squad_id: squadB.id });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already registered/);
  });

  // ...unless the organizer explicitly allows it.
  await as('organizer', () => api('PATCH', `/api/tournaments/${tournamentId}`, { keep_slug: true, allow_multi_team: true }));
  await as('rival', async () => {
    const res = await api('POST', `/api/tournaments/${tournamentId}/register`, { squad_id: squadB.id });
    assert.equal(res.status, 201, 'allowed once the organizer opts in');
  });
  await as('organizer', () => api('PATCH', `/api/tournaments/${tournamentId}`, { keep_slug: true, allow_multi_team: false }));
});

test('registration closes when the slots are full', async () => {
  await as('organizer', async () => {
    await api('PATCH', `/api/tournaments/${tournamentId}`, { keep_slug: true, slots: 2 });
    const state = await api('GET', `/api/tournaments/${tournamentId}/registration`);
    assert.equal(state.body.state.full, true);
    assert.equal(state.body.state.open, false);
    assert.match(state.body.state.reason, /slots/i);
    await api('PATCH', `/api/tournaments/${tournamentId}`, { keep_slug: true, slots: 16 });
  });
});

test('registration respects the deadline', async () => {
  await as('organizer', async () => {
    await api('PATCH', `/api/tournaments/${tournamentId}`, { keep_slug: true, registration_deadline: '2020-01-01 00:00' });
    const state = await api('GET', `/api/tournaments/${tournamentId}/registration`);
    assert.equal(state.body.state.open, false);
    assert.match(state.body.state.reason, /deadline/i);
    await api('PATCH', `/api/tournaments/${tournamentId}`, { keep_slug: true, registration_deadline: null });
  });
});

test('closing registration flips the public state', async () => {
  await as('organizer', async () => {
    const closed = await api('POST', `/api/tournaments/${tournamentId}/registration/toggle`, { open: false });
    assert.equal(closed.body.state.open, false);
    const reopened = await api('POST', `/api/tournaments/${tournamentId}/registration/toggle`, { open: true });
    assert.equal(reopened.body.state.open, true);
  });
});

test('a captain can withdraw, which removes the team again', async () => {
  await as('rival', async () => {
    const mine = await api('GET', `/api/tournaments/${tournamentId}/registration`);
    const registration = mine.body.my_registration;
    assert.ok(registration);
    const res = await api('POST', `/api/tournaments/${tournamentId}/registrations/${registration.id}/withdraw`);
    assert.equal(res.status, 200);
  });
  const teams = await as('organizer', () => api('GET', `/api/tournaments/${tournamentId}/teams`));
  assert.equal(teams.body.teams.length, 1, 'the withdrawn team is gone');
});

test('check-in refuses outside the window and works inside it', async () => {
  await as('captain', async () => {
    const early = await api('POST', `/api/tournaments/${tournamentId}/check-in`, {});
    assert.equal(early.status, 400, 'no matches scheduled yet, so check-in is not open');
  });

  // Give the tournament a match starting soon so the window opens.
  await as('organizer', async () => {
    const now = new Date(Date.now() + 20 * 60_000);
    const pad = (n) => String(n).padStart(2, '0');
    const at = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    await api('POST', `/api/tournaments/${tournamentId}/matches`, { label: 'Check-in match', scheduled_at: at });
  });

  await as('captain', async () => {
    const window = await api('GET', `/api/tournaments/${tournamentId}/check-in`);
    assert.equal(window.body.window.enabled, true);
    assert.equal(window.body.window.open, true, JSON.stringify(window.body.window));

    const res = await api('POST', `/api/tournaments/${tournamentId}/check-in`, {});
    assert.equal(res.status, 200);
    assert.ok(res.body.registration.checked_in_at);
  });
});

test('the organizer sees who has not checked in', async () => {
  await as('organizer', async () => {
    const res = await api('GET', `/api/tournaments/${tournamentId}/registrations`);
    assert.equal(res.body.no_shows.length, 0, 'the only approved team checked in');
  });
});

// ------------------------------------------------------- scoring & results --
test('scoring presets are seeded and can be applied to a tournament', async () => {
  const presets = await api('GET', '/api/scoring-presets');
  assert.ok(presets.body.presets.length >= 4);
  const kills = presets.body.presets.find((p) => p.name === 'Kills Only');
  assert.ok(kills, 'the built-in systems are present');

  await as('organizer', async () => {
    const applied = await api('POST', `/api/tournaments/${tournamentId}/scoring-preset`, { preset_id: kills.id });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.settings.scoring.killPoints, 1);
    assert.equal(applied.body.settings.tiebreakers[0], 'total_kills');

    // Put the standard system back for the rest of the run.
    const standard = presets.body.presets.find((p) => p.name === 'BGMI Standard');
    await api('POST', `/api/tournaments/${tournamentId}/scoring-preset`, { preset_id: standard.id });
  });
});

test('an organizer can save the current rules as a reusable scoring system', async () => {
  await as('organizer', async () => {
    const res = await api('POST', '/api/scoring-presets', {
      name: 'Platform Cup Rules', tournament_id: tournamentId, description: 'Saved from the cup',
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.preset.config.scoring.placementPoints);
  });
});

test('penalties come off the standings and can be revoked', async () => {
  // Add a second team and play a match so there is something to rank.
  await as('organizer', async () => {
    await api('POST', `/api/tournaments/${tournamentId}/teams`, { name: 'Filler Squad' });
    const teams = await api('GET', `/api/tournaments/${tournamentId}/teams`);
    const ids = teams.body.teams.map((t) => t.id);

    const created = await api('POST', `/api/tournaments/${tournamentId}/matches`, {
      label: 'Scored match', team_ids: ids,
    });
    const matchId = created.body.match.id;
    await api('PUT', `/api/matches/${matchId}/results`, {
      status: 'completed',
      entries: [
        { team_id: ids[0], placement: 1, kills: 10 },
        { team_id: ids[1], placement: 2, kills: 4 },
      ],
    });

    const before = await api('GET', `/api/tournaments/${tournamentId}/leaderboard`);
    const leader = before.body.standings[0];
    assert.equal(leader.total_points, 20, '10 placement + 10 kills');

    const penalty = await api('POST', `/api/tournaments/${tournamentId}/penalties`, {
      team_id: leader.team_id, kind: 'points', points: 15, reason: 'Late start',
    });
    assert.equal(penalty.status, 201);

    const after = await api('GET', `/api/tournaments/${tournamentId}/leaderboard`);
    const penalised = after.body.standings.find((s) => s.team_id === leader.team_id);
    assert.equal(penalised.total_points, 5, '20 - 15');
    assert.equal(penalised.rank, 2, 'and it drops down the table');

    const revoked = await api('DELETE', `/api/tournaments/${tournamentId}/penalties/${penalty.body.penalty.id}`);
    assert.equal(revoked.status, 200);
    const restored = await api('GET', `/api/tournaments/${tournamentId}/leaderboard`);
    assert.equal(restored.body.standings[0].total_points, 20, 'revoking restores the table exactly');
  });
});

test('a disqualification marks the team and is reversible', async () => {
  await as('organizer', async () => {
    const teams = await api('GET', `/api/tournaments/${tournamentId}/teams`);
    const victim = teams.body.teams.find((t) => t.name === 'Filler Squad');

    const dq = await api('POST', `/api/tournaments/${tournamentId}/penalties`, {
      team_id: victim.id, kind: 'disqualification', reason: 'Roster breach',
    });
    assert.equal(dq.status, 201);

    const after = await api('GET', `/api/tournaments/${tournamentId}/teams`);
    const marked = after.body.teams.find((t) => t.id === victim.id);
    assert.equal(marked.disqualified, 1);
    assert.equal(marked.status, 'eliminated');

    await api('DELETE', `/api/tournaments/${tournamentId}/penalties/${dq.body.penalty.id}`);
    const restored = await api('GET', `/api/tournaments/${tournamentId}/teams`);
    assert.equal(restored.body.teams.find((t) => t.id === victim.id).disqualified, 0);
  });
});

test('penalties require a reason', async () => {
  await as('organizer', async () => {
    const res = await api('POST', `/api/tournaments/${tournamentId}/penalties`, { kind: 'points', points: 5, reason: '' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /reason/i);
  });
});

test('players cannot apply penalties or edit results', async () => {
  await as('captain', async () => {
    const penalty = await api('POST', `/api/tournaments/${tournamentId}/penalties`, {
      kind: 'points', points: 100, reason: 'cheating my way to the top',
    });
    assert.equal(penalty.status, 403);

    const matches = await api('GET', `/api/tournaments/${tournamentId}/matches`);
    const scored = matches.body.matches.find((m) => m.status === 'completed');
    const tamper = await api('PUT', `/api/matches/${scored.id}/results`, { entries: [] });
    assert.equal(tamper.status, 403, 'players must never be able to modify results');
  });
});

test('per-player kills power the individual boards', async () => {
  await as('organizer', async () => {
    const matches = await api('GET', `/api/tournaments/${tournamentId}/matches`);
    const scored = matches.body.matches.find((m) => m.status === 'completed');

    const before = await api('GET', `/api/tournaments/${tournamentId}/player-stats`);
    assert.equal(before.body.individual, false, 'falls back to team figures with no data');
    assert.equal(before.body.players[0].kills, null, 'and never presents team kills as personal ones');

    const roster = await api('GET', `/api/matches/${scored.id}/player-stats`);
    const players = roster.body.teams.flatMap((t) => t.players);
    assert.ok(players.length >= 2);

    const saved = await api('PUT', `/api/matches/${scored.id}/player-stats`, {
      entries: players.map((p, i) => ({ player_id: p.id, kills: i === 0 ? 7 : 1, damage: 500 })),
    });
    assert.equal(saved.body.written, players.length);

    const after = await api('GET', `/api/tournaments/${tournamentId}/player-stats`);
    assert.equal(after.body.individual, true);
    assert.equal(after.body.source, 'player_stats');
    assert.equal(after.body.players[0].kills, 7);
    assert.ok(after.body.mvp.players.length > 0, 'MVP board is produced');
    assert.ok(after.body.mvp.players[0].mvp_score > 0);
  });
});

test('result corrections are kept with before and after values', async () => {
  await as('organizer', async () => {
    const matches = await api('GET', `/api/tournaments/${tournamentId}/matches`);
    const scored = matches.body.matches.find((m) => m.status === 'completed');
    const detail = await api('GET', `/api/matches/${scored.id}`);
    const ids = detail.body.match.participants.map((p) => p.team_id);

    await api('PUT', `/api/matches/${scored.id}/results`, {
      status: 'completed',
      entries: [
        { team_id: ids[0], placement: 1, kills: 12 },
        { team_id: ids[1], placement: 2, kills: 4 },
      ],
    });

    const history = await api('GET', `/api/tournaments/${tournamentId}/result-history`);
    const edit = history.body.entries.find((e) => e.action === 'result.updated');
    assert.ok(edit, 'the correction is recorded');
    assert.ok(edit.actor, 'with who made it');
    const killChange = edit.changes.find((c) => c.field === 'kills');
    assert.ok(killChange, 'and what changed');
    assert.equal(killChange.from, 10);
    assert.equal(killChange.to, 12);
  });
});

// ------------------------------------------------------ discovery & search --
test('discovery lists public tournaments and filters them', async () => {
  await as('organizer', () => api('PATCH', `/api/tournaments/${tournamentId}`, { keep_slug: true, status: 'live' }));

  const all = await api('GET', '/api/discover');
  assert.ok(all.body.tournaments.length >= 1);
  const found = all.body.tournaments.find((t) => t.id === tournamentId);
  assert.ok(found);
  assert.equal(found.organizer, 'Org Owner');
  assert.ok(found.registered >= 1, 'shows how many teams have registered');

  const live = await api('GET', '/api/discover?status=live');
  assert.ok(live.body.tournaments.some((t) => t.id === tournamentId));

  const wrongGame = await api('GET', '/api/discover?game=Valorant');
  assert.ok(!wrongGame.body.tournaments.some((t) => t.id === tournamentId));

  const registering = await api('GET', '/api/discover?status=registering');
  assert.ok(registering.body.tournaments.some((t) => t.id === tournamentId));
});

test('"my tournaments" only shows events the caller entered', async () => {
  await as('captain', async () => {
    const mine = await api('GET', '/api/discover?mine=1');
    assert.ok(mine.body.tournaments.some((t) => t.id === tournamentId));
  });
  await as('organizer', async () => {
    // The organizer owns it but has not entered a team.
    const mine = await api('GET', '/api/discover?mine=1');
    assert.ok(!mine.body.tournaments.some((t) => t.id === tournamentId));
  });
});

test('global search finds tournaments, teams, players and matches', async () => {
  const teams = await api('GET', '/api/search?q=Alpha');
  assert.ok(teams.body.results.some((r) => r.kind === 'team' && r.title === 'Alpha Wolves'));

  const players = await api('GET', '/api/search?q=CAPxGOD');
  assert.ok(players.body.results.some((r) => r.kind === 'player'));

  const tournaments = await api('GET', '/api/search?q=Platform');
  assert.ok(tournaments.body.results.some((r) => r.kind === 'tournament'));

  const short = await api('GET', '/api/search?q=a');
  assert.equal(short.body.results.length, 0, 'one-character searches are ignored');
});

test('the public team page shows roster, stats and history', async () => {
  const res = await api('GET', `/api/squads/${squadA.slug}`, null, { as: 'nobody' });
  assert.equal(res.status, 200);
  assert.equal(res.body.squad.name, 'Alpha Wolves');
  assert.ok(res.body.members.length >= 1);
  assert.equal(res.body.can_manage, false, 'signed-out visitors cannot manage it');
  assert.ok(res.body.stats.matches >= 1, 'cumulative stats are derived');
  assert.ok(res.body.history.length >= 1, 'tournament history is listed');
});

test('the public player page never exposes contact details', async () => {
  const res = await api('GET', `/api/players/${users.captain.id}`, null, { as: 'nobody' });
  assert.equal(res.status, 200);
  assert.equal(res.body.player.ign, 'CAPxGOD');
  assert.ok(!('phone' in res.body.player), 'phone number is private');
  assert.ok(!('email' in res.body.player), 'email is private');
  assert.ok(res.body.career, 'career statistics are public');
});

test('the player dashboard gathers tournaments, team and matches', async () => {
  await as('captain', async () => {
    const res = await api('GET', '/api/me/dashboard');
    assert.equal(res.status, 200);
    assert.equal(res.body.profile_complete, true);
    assert.ok(res.body.squads.length >= 1);
    assert.ok(res.body.tournaments.all.length >= 1);
    assert.ok(Array.isArray(res.body.matches));
    assert.ok(res.body.career);
  });
});

test('a participant sees their own room details; a spectator never does', async () => {
  let matchId;
  await as('organizer', async () => {
    const matches = await api('GET', `/api/tournaments/${tournamentId}/matches`);
    matchId = matches.body.matches.find((m) => m.status === 'completed').id;
    await api('PATCH', `/api/matches/${matchId}`, {
      room_id: '777888', room_password: 'secret', reveal_policy: 'immediate',
    });
  });

  await as('captain', async () => {
    const res = await api('GET', `/api/public/t/${tournamentSlug}/match/${matchId}`);
    assert.equal(res.body.match.credentials.participant, true);
    assert.equal(res.body.match.room_id, '777888');
  });

  const anon = await api('GET', `/api/public/t/${tournamentSlug}/match/${matchId}`, null, { as: 'nobody' });
  assert.equal(anon.body.match.room_id, null);
  assert.equal(anon.body.match.credentials.reason, 'participants_only');

  await as('rival', async () => {
    const res = await api('GET', `/api/public/t/${tournamentSlug}/match/${matchId}`);
    assert.equal(res.body.match.room_id, null, 'a signed-in non-participant is still shut out');
  });
});

test('the public tournament page exposes rules, progression and live data', async () => {
  const rules = await api('GET', `/api/public/t/${tournamentSlug}/rules`, null, { as: 'nobody' });
  assert.ok(rules.body.rules_html.includes('No emulators'));
  assert.ok(!rules.body.rules_html.includes('<script'));
  assert.ok(rules.body.scoring.placementPoints);

  const progression = await api('GET', `/api/public/t/${tournamentSlug}/progression`, null, { as: 'nobody' });
  assert.ok(Array.isArray(progression.body.steps));
  assert.ok(progression.body.registration);

  const live = await api('GET', `/api/public/t/${tournamentSlug}/live`, null, { as: 'nobody' });
  assert.ok(Array.isArray(live.body.live));
  assert.ok(live.body.standings.length >= 1);
  assert.ok(live.body.updated_at);
});

test('the platform home page reports counts and leaderboards', async () => {
  const res = await api('GET', '/api/discover/home', null, { as: 'nobody' });
  assert.ok(res.body.counts.tournaments >= 1);
  assert.ok(res.body.counts.teams >= 2);
  assert.ok(res.body.counts.players >= 3);
  assert.ok(res.body.leaderboards);
});

test('sign-in is rate limited', async () => {
  let limited = false;
  for (let i = 0; i < 25; i++) {
    const res = await api('POST', '/api/auth/login', { email: 'org@example.com', password: 'wrong' }, { as: 'bruteforce' });
    if (res.status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'repeated failed sign-ins are throttled');
});

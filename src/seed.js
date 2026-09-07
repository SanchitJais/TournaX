/**
 * Demo data.
 *   node src/seed.js            -- top up (safe to re-run)
 *   node src/seed.js --reset    -- wipe the database first
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tournament.db');

if (process.argv.includes('--reset')) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${DB_PATH}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  console.log('Removed existing database.');
}

const { all, get, insert, run, toJson, tx } = await import('./db.js');
const { createUser } = await import('./auth.js');
const { DEFAULT_SETTINGS, SYSTEM_TEMPLATES } = await import('./config.js');
const { generateStageFixtures } = await import('./services/scheduler.js');
const { computeResult } = await import('./services/scoring.js');
const { makeRng } = await import('./services/fixtures.js');

const rng = makeRng(20260904);
const pick = (list) => list[Math.floor(rng() * list.length)];

// ------------------------------------------------------------------- users --
const ACCOUNTS = [
  { email: 'admin@tournament.local', name: 'Aarav Menon', role: 'super_admin', password: 'admin1234' },
  { email: 'organizer@tournament.local', name: 'Priya Nair', role: 'tournament_admin', password: 'organizer1234' },
  { email: 'scorer@tournament.local', name: 'Rehan Qureshi', role: 'scorekeeper', password: 'scorer1234' },
  { email: 'manager@tournament.local', name: 'Divya Rao', role: 'team_manager', password: 'manager1234' },
];

const userIds = {};
for (const account of ACCOUNTS) {
  const existing = get('SELECT id FROM users WHERE email = ?', [account.email]);
  userIds[account.role] = existing?.id ?? createUser(account);
}
console.log(`Users ready (${ACCOUNTS.length}).`);

// --------------------------------------------------------------- templates --
for (const template of SYSTEM_TEMPLATES) {
  if (get('SELECT id FROM templates WHERE name = ?', [template.name])) continue;
  insert(
    'INSERT INTO templates (name, game, description, config, is_system) VALUES (?, ?, ?, ?, 1)',
    [template.name, template.game, template.description, toJson(template.config)],
  );
}
console.log(`Templates ready (${SYSTEM_TEMPLATES.length}).`);

// -------------------------------------------------------------- tournament --
const SLUG = 'bgmi-pro-series-2026';
if (get('SELECT id FROM tournaments WHERE slug = ?', [SLUG])) {
  console.log('Demo tournament already present -- nothing else to do.');
  process.exit(0);
}

const TEAMS = [
  ['Soul Esports', 'SOUL', 'Mortal'], ['GodLike Esports', 'GOD', 'Jonathan'],
  ['Team XSpark', 'TX', 'Scout'], ['Blind Esports', 'BLND', 'Zeus'],
  ['Orangutan Gaming', 'OG', 'Aditya'], ['Gladiators Esports', 'GLAD', 'Sensei'],
  ['Revenant Esports', 'RVNT', 'Sarang'], ['Hyderabad Hydras', 'HYD', 'Rony'],
  ['Team Insane', 'INS', 'Punkk'], ['Enigma Gaming', 'ENG', 'Ronak'],
  ['Medal Esports', 'MDL', 'Nakul'], ['Chemin Esports', 'CHM', 'Kaustubh'],
  ['Reckoning Esports', 'RCK', 'Snaxx'], ['Autobotz Esports', 'ABZ', 'Vexe'],
  ['Numen Gaming', 'NUM', 'Slayer'], ['Velocity Gaming', 'VLT', 'Aggressor'],
];

const PLAYER_NAMES = [
  'Owais', 'Viper', 'Regaltos', 'Hector', 'Neyoo', 'Sarang', 'Punkk', 'Attanki',
  'Shadow', 'Ghatak', 'Clutchgod', 'Zgod', 'Snax', 'Aman', 'Karan', 'Nakul',
  'Rony', 'Spraygod', 'Omega', 'Blaze', 'Frost', 'Nova', 'Rex', 'Kaze',
];

const tournamentId = tx(() => {
  const id = insert(
    `INSERT INTO tournaments
       (slug, name, game, format_type, match_format, description, num_teams, num_groups,
        num_rounds, matches_per_round, teams_per_match, start_date, end_date, prize_pool,
        status, is_public, owner_id)
     VALUES (?, ?, 'BGMI', 'battle_royale', 'Squad (TPP)', ?, 16, 1, 1, 6, 16, ?, ?, ?, 'live', 1, ?)`,
    [
      SLUG, 'BGMI Pro Series 2026',
      'Sixteen invited squads, six matches, one champion. Official BGMI points system with kill points counting throughout.',
      '2026-09-10', '2026-09-12', 'Rs 25,00,000', userIds.super_admin,
    ],
  );

  const settings = DEFAULT_SETTINGS();
  settings.qualification = { mode: 'top_overall', count: 8, perGroup: 3, customTeamIds: [] };
  settings.schedule_options = { firstMatchTime: '19:00', matchGapMinutes: 45, matchesPerDay: 3, dayBreakMinutes: 0 };
  run(
    `INSERT INTO tournament_settings
       (tournament_id, scoring, tiebreakers, qualification, fixture_options, schedule_options, notification_prefs)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id, toJson(settings.scoring), toJson(settings.tiebreakers), toJson(settings.qualification),
      toJson(settings.fixture_options), toJson(settings.schedule_options), toJson(settings.notification_prefs),
    ],
  );

  insert(
    `INSERT INTO stages (tournament_id, name, kind, order_index, status, num_groups, num_rounds, matches_per_round, teams_per_match)
     VALUES (?, 'League Stage', 'group_stage', 0, 'live', 1, 1, 6, 16)`,
    [id],
  );

  TEAMS.forEach(([name, tag, captain], index) => {
    const teamId = insert(
      `INSERT INTO teams (tournament_id, name, tag, team_code, captain_name, captain_contact, seed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, name, tag, `T-${String(index + 1).padStart(3, '0')}`, captain, `${captain.toLowerCase()}@example.com`, index + 1],
    );
    const roster = [captain, ...Array.from({ length: 3 }, () => pick(PLAYER_NAMES))];
    roster.forEach((playerName, slot) => {
      insert(
        'INSERT INTO players (team_id, name, in_game_id, is_captain, order_index) VALUES (?, ?, ?, ?, ?)',
        [teamId, playerName, `5${Math.floor(rng() * 9e8 + 1e8)}`, slot === 0 ? 1 : 0, slot],
      );
    });
  });

  insert(
    'INSERT INTO tournament_members (tournament_id, user_id, role) VALUES (?, ?, ?)',
    [id, userIds.scorekeeper, 'scorekeeper'],
  );
  insert(
    'INSERT INTO tournament_members (tournament_id, user_id, role) VALUES (?, ?, ?)',
    [id, userIds.tournament_admin, 'tournament_admin'],
  );
  // Attach the demo team manager to a real team so that role has something to see.
  const firstTeam = get('SELECT id FROM teams WHERE tournament_id = ? ORDER BY seed LIMIT 1', [id]);
  insert(
    'INSERT INTO tournament_members (tournament_id, user_id, role, team_id) VALUES (?, ?, ?, ?)',
    [id, userIds.team_manager, 'team_manager', firstTeam.id],
  );
  return id;
});

console.log(`Created tournament #${tournamentId} with ${TEAMS.length} teams.`);

// ----------------------------------------------------------------- fixtures --
const tournament = get('SELECT * FROM tournaments WHERE id = ?', [tournamentId]);
const settingsRow = get('SELECT * FROM tournament_settings WHERE tournament_id = ?', [tournamentId]);
const stage = get('SELECT * FROM stages WHERE tournament_id = ? ORDER BY order_index LIMIT 1', [tournamentId]);
const teams = all('SELECT * FROM teams WHERE tournament_id = ? ORDER BY seed', [tournamentId]);

const { matches } = generateStageFixtures({
  tournament,
  settings: settingsRow,
  stage,
  teams,
  actor: { id: userIds.super_admin, name: 'Seed script' },
});
console.log(`Generated ${matches} fixtures.`);

// ------------------------------------------------------------------ results --
// Play out the first four matches so the leaderboard has something to show.
const scoring = JSON.parse(settingsRow.scoring);
const played = all('SELECT * FROM matches WHERE tournament_id = ? ORDER BY match_no LIMIT 4', [tournamentId]);

for (const match of played) {
  const lineup = all(
    'SELECT team_id FROM match_participants WHERE match_id = ? ORDER BY slot',
    [match.id],
  ).map((r) => r.team_id);

  // Shuffle into a finishing order, then hand out plausible kill counts.
  const order = [...lineup].sort(() => rng() - 0.5);
  tx(() => {
    order.forEach((teamId, index) => {
      const placement = index + 1;
      // Teams that survive longer tend to have more kills.
      const kills = Math.max(0, Math.round((16 - placement) / 2 + rng() * 4 - 1));
      const row = computeResult({ team_id: teamId, placement, kills }, scoring);
      insert(
        `INSERT INTO match_results
           (match_id, team_id, placement, kills, placement_points, kill_points, bonus_points,
            penalty_points, total_points, is_win, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          match.id, row.team_id, row.placement, row.kills, row.placement_points, row.kill_points,
          row.bonus_points, row.penalty_points, row.total_points, row.is_win, userIds.scorekeeper,
        ],
      );
    });
    run("UPDATE matches SET status = 'completed' WHERE id = ?", [match.id]);
  });
}
run(
  `UPDATE matches SET status = 'live' WHERE id = (
     SELECT id FROM matches WHERE tournament_id = ? AND status = 'upcoming' ORDER BY match_no LIMIT 1)`,
  [tournamentId],
);
console.log(`Recorded results for ${played.length} matches, next match set to live.`);

// A couple of matches with room details already published.
run(
  `UPDATE matches SET room_id = '4471829', room_password = 'bgmi2026',
          credentials_reveal_at = datetime('now', '-1 hour')
    WHERE tournament_id = ? AND status IN ('live','upcoming')`,
  [tournamentId],
);

console.log('\nSeed complete. Sign in with:');
for (const a of ACCOUNTS) console.log(`  ${a.role.padEnd(18)} ${a.email}  /  ${a.password}`);
console.log(`\nPublic page: /t/${SLUG}\n`);

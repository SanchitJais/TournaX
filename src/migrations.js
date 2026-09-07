/**
 * Additive schema migrations.
 *
 * The platform grew from a fixture tool into a full esports platform, so the
 * original tables must keep working exactly as they are. Everything here is
 * additive and idempotent: new tables, new nullable columns, new indexes.
 * No existing column is dropped, renamed or retyped, so existing tournaments,
 * teams, fixtures and results survive every upgrade untouched.
 */

const NEW_TABLES = `
-- ------------------------------------------------------------ identity ----
-- Third-party sign-in. Kept separate from users so one account can link
-- several providers later without touching the users table.
CREATE TABLE IF NOT EXISTS oauth_accounts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,              -- 'google'
  provider_user_id TEXT NOT NULL,
  email            TEXT,
  raw_profile      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_accounts(user_id);

-- One profile per signed-in human. Starred fields in the UI are the NOT NULLs.
CREATE TABLE IF NOT EXISTS player_profiles (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  ign         TEXT NOT NULL,
  in_game_id  TEXT,
  phone       TEXT NOT NULL,
  alt_contact TEXT,
  game        TEXT NOT NULL DEFAULT 'BGMI',
  country     TEXT,
  region      TEXT,                            -- state / city
  discord     TEXT,
  socials     TEXT,                            -- JSON {youtube,instagram,x,twitch}
  avatar_url  TEXT,
  bio         TEXT,
  is_complete INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_profiles_ign ON player_profiles(ign);

-- ------------------------------------------------------- persistent teams --
-- A squad lives across tournaments. The existing per-tournament "teams" row
-- becomes that squad's entry in one event (teams.squad_id), which is what
-- gives a team its history, stats and profile page.
CREATE TABLE IF NOT EXISTS squads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  slug       TEXT NOT NULL UNIQUE,
  tag        TEXT,
  logo_url   TEXT,
  game       TEXT NOT NULL DEFAULT 'BGMI',
  owner_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  team_code  TEXT,
  region     TEXT,
  bio        TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_squads_owner ON squads(owner_id);

CREATE TABLE IF NOT EXISTS squad_members (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  squad_id  INTEGER NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'player',    -- captain | player | substitute
  status    TEXT NOT NULL DEFAULT 'active',    -- active | left | removed
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(squad_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_squad_members_user ON squad_members(user_id, status);

CREATE TABLE IF NOT EXISTS squad_invites (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  squad_id      INTEGER NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  invited_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  invited_email TEXT,
  invited_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  role          TEXT NOT NULL DEFAULT 'player',
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|rejected|cancelled
  message       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_invites_user ON squad_invites(invited_user_id, status);
CREATE INDEX IF NOT EXISTS idx_invites_email ON squad_invites(invited_email, status);

-- ---------------------------------------------------------- registration --
CREATE TABLE IF NOT EXISTS tournament_registrations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  squad_id      INTEGER REFERENCES squads(id) ON DELETE CASCADE,
  team_id       INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  submitted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  team_name     TEXT NOT NULL,
  contact_name  TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  roster        TEXT,                          -- JSON snapshot taken at sign-up
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|withdrawn
  reject_reason TEXT,
  decided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TEXT,
  -- Check-in is one timestamp on the registration rather than its own table:
  -- a separate row would duplicate state that only ever has one value.
  checked_in_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tournament_id, squad_id)
);
CREATE INDEX IF NOT EXISTS idx_regs_tournament ON tournament_registrations(tournament_id, status);
CREATE INDEX IF NOT EXISTS idx_regs_squad ON tournament_registrations(squad_id);

-- ----------------------------------------------------- penalties & rules --
-- Tournament-level sanctions. Match-level penalty points stay on
-- match_results; these are the standalone ones (late start, misconduct, DQ).
CREATE TABLE IF NOT EXISTS penalties (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_id       INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  match_id      INTEGER REFERENCES matches(id) ON DELETE SET NULL,
  player_id     INTEGER REFERENCES players(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL,                 -- points|disqualification|suspension|warning
  points        REAL NOT NULL DEFAULT 0,
  reason        TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_penalties_tournament ON penalties(tournament_id, active);
CREATE INDEX IF NOT EXISTS idx_penalties_team ON penalties(team_id, active);

-- Reusable scoring systems ("BGMI Standard", "TDM", custom).
CREATE TABLE IF NOT EXISTS scoring_presets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  game        TEXT NOT NULL DEFAULT 'BGMI',
  description TEXT,
  config      TEXT NOT NULL,                   -- {scoring, tiebreakers}
  is_system   INTEGER NOT NULL DEFAULT 0,
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/** table -> [[column, definition], ...] */
const NEW_COLUMNS = {
  tournaments: [
    ['registration_open', 'INTEGER NOT NULL DEFAULT 0'],
    ['registration_opens_at', 'TEXT'],
    ['registration_deadline', 'TEXT'],
    ['slots', 'INTEGER'],
    ['approval_mode', "TEXT NOT NULL DEFAULT 'auto'"],      // auto | manual
    ['check_in_enabled', 'INTEGER NOT NULL DEFAULT 0'],
    ['check_in_minutes_before', 'INTEGER NOT NULL DEFAULT 60'],
    ['check_in_close_minutes', 'INTEGER NOT NULL DEFAULT 15'],
    ['rules_html', 'TEXT'],
    ['region', 'TEXT'],
    ['organizer_name', 'TEXT'],
    ['entry_requirements', 'TEXT'],
    ['min_players', 'INTEGER NOT NULL DEFAULT 4'],
    ['max_players', 'INTEGER NOT NULL DEFAULT 6'],
    ['default_reveal_minutes', 'INTEGER NOT NULL DEFAULT 15'],
    // Off by default: a player may only appear in one team per tournament.
    ['allow_multi_team', 'INTEGER NOT NULL DEFAULT 0'],
  ],
  teams: [
    ['squad_id', 'INTEGER REFERENCES squads(id) ON DELETE SET NULL'],
    ['registration_id', 'INTEGER REFERENCES tournament_registrations(id) ON DELETE SET NULL'],
    ['checked_in_at', 'TEXT'],
    ['disqualified', 'INTEGER NOT NULL DEFAULT 0'],
  ],
  players: [
    ['user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
    ['is_substitute', 'INTEGER NOT NULL DEFAULT 0'],
  ],
  matches: [
    // manual | immediate | minutes  (minutes uses reveal_minutes_before)
    ['reveal_policy', "TEXT NOT NULL DEFAULT 'manual'"],
    ['reveal_minutes_before', 'INTEGER'],
  ],
  users: [
    ['profile_complete', 'INTEGER NOT NULL DEFAULT 0'],
  ],
};

const EXTRA_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_teams_squad ON teams(squad_id)',
  'CREATE INDEX IF NOT EXISTS idx_players_user ON players(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status, is_public)',
  'CREATE INDEX IF NOT EXISTS idx_tournaments_reg ON tournaments(registration_open, is_public)',
];

/**
 * Apply everything that is missing. Safe to run on every boot.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function migrate(db) {
  db.exec(NEW_TABLES);

  const applied = [];
  for (const [table, columns] of Object.entries(NEW_COLUMNS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, definition] of columns) {
      if (existing.has(name)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      applied.push(`${table}.${name}`);
    }
  }

  for (const sql of EXTRA_INDEXES) db.exec(sql);

  if (applied.length) {
    db.prepare('INSERT OR REPLACE INTO schema_migrations (id) VALUES (?)')
      .run(`columns:${new Date().toISOString()}`);
    if (!process.env.QUIET) {
      console.log(`[migrate] added ${applied.length} column(s): ${applied.join(', ')}`);
    }
  }
  return applied;
}

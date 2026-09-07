-- ============================================================================
-- Tournament Management & Fixture Automation  --  relational schema
-- Design rule: rankings & statistics are DERIVED from match_results,
-- never manually stored. See src/services/leaderboard.js.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- identity --
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  -- super_admin | tournament_admin | scorekeeper | team_manager | spectator
  role          TEXT NOT NULL DEFAULT 'spectator',
  avatar_url    TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ------------------------------------------------------------- tournament --
CREATE TABLE IF NOT EXISTS tournaments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  game              TEXT NOT NULL DEFAULT 'BGMI',
  -- battle_royale | round_robin | single_elimination | groups_knockout
  format_type       TEXT NOT NULL DEFAULT 'battle_royale',
  match_format      TEXT NOT NULL DEFAULT 'Squad (TPP)',
  description       TEXT,
  banner_url        TEXT,
  logo_url          TEXT,
  num_teams         INTEGER NOT NULL DEFAULT 16,
  num_groups        INTEGER NOT NULL DEFAULT 1,
  num_rounds        INTEGER NOT NULL DEFAULT 1,
  matches_per_round INTEGER NOT NULL DEFAULT 4,
  teams_per_match   INTEGER NOT NULL DEFAULT 16,
  start_date        TEXT,
  end_date          TEXT,
  timezone          TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  prize_pool        TEXT,
  status            TEXT NOT NULL DEFAULT 'draft',   -- draft | live | completed | archived
  is_public         INTEGER NOT NULL DEFAULT 1,
  owner_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tournaments_owner ON tournaments(owner_id);

-- 1:1 settings. JSON-encoded so scoring / tiebreak / qualification rules
-- stay organizer-definable without a migration per rule.
CREATE TABLE IF NOT EXISTS tournament_settings (
  tournament_id      INTEGER PRIMARY KEY REFERENCES tournaments(id) ON DELETE CASCADE,
  scoring            TEXT NOT NULL,   -- {placementPoints:{}, killPoints, winBonus}
  tiebreakers        TEXT NOT NULL,   -- ordered array of tiebreaker keys
  qualification      TEXT NOT NULL,   -- {mode, count, perGroup, customTeamIds}
  fixture_options    TEXT NOT NULL,   -- {mode, seeded, shuffle, avoidRepeats}
  schedule_options   TEXT NOT NULL,   -- {firstMatchTime, matchGapMinutes, matchesPerDay}
  notification_prefs TEXT NOT NULL,   -- {events:{}, channels:{}}
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --------------------------------------------------------- stages & groups --
CREATE TABLE IF NOT EXISTS stages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id     INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  -- group_stage | round_of_32 | round_of_16 | quarter_final | semi_final
  -- | grand_final | custom
  kind              TEXT NOT NULL DEFAULT 'group_stage',
  order_index       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending | live | completed
  num_groups        INTEGER NOT NULL DEFAULT 1,
  num_rounds        INTEGER NOT NULL DEFAULT 1,
  matches_per_round INTEGER NOT NULL DEFAULT 1,
  teams_per_match   INTEGER NOT NULL DEFAULT 16,
  qualification     TEXT,             -- JSON override of tournament qualification
  source_stage_id   INTEGER REFERENCES stages(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stages_tournament ON stages(tournament_id, order_index);

CREATE TABLE IF NOT EXISTS groups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  stage_id      INTEGER REFERENCES stages(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  order_index   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_groups_stage ON groups(stage_id);

-- ------------------------------------------------------------------ teams --
CREATE TABLE IF NOT EXISTS teams (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id   INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  tag             TEXT,
  team_code       TEXT,                  -- organizer-facing team ID
  logo_url        TEXT,
  captain_name    TEXT,
  captain_contact TEXT,
  group_id        INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  seed            INTEGER,
  status          TEXT NOT NULL DEFAULT 'active',  -- active|qualified|eliminated|withdrawn
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tournament_id, name)
);
CREATE INDEX IF NOT EXISTS idx_teams_tournament ON teams(tournament_id);
CREATE INDEX IF NOT EXISTS idx_teams_group ON teams(group_id);

CREATE TABLE IF NOT EXISTS players (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  in_game_id  TEXT,
  role        TEXT,
  is_captain  INTEGER NOT NULL DEFAULT 0,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);

-- Per-tournament access grants; scopes the global role.
CREATE TABLE IF NOT EXISTS tournament_members (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,      -- tournament_admin | scorekeeper | team_manager
  team_id       INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tournament_id, user_id, team_id)
);

-- ------------------------------------------------------- rounds & matches --
CREATE TABLE IF NOT EXISTS rounds (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  stage_id      INTEGER NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  order_index   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rounds_stage ON rounds(stage_id, order_index);

CREATE TABLE IF NOT EXISTS matches (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id         INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  stage_id              INTEGER NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  round_id              INTEGER REFERENCES rounds(id) ON DELETE SET NULL,
  group_id              INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  match_no              INTEGER NOT NULL,
  label                 TEXT,
  map                   TEXT,
  scheduled_at          TEXT,
  room_id               TEXT,
  room_password         TEXT,
  credentials_reveal_at TEXT,
  status                TEXT NOT NULL DEFAULT 'upcoming', -- upcoming|live|completed|cancelled
  notes                 TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_matches_tournament ON matches(tournament_id, match_no);
CREATE INDEX IF NOT EXISTS idx_matches_stage ON matches(stage_id);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(tournament_id, status);

CREATE TABLE IF NOT EXISTS match_participants (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id  INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  slot     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(match_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_mp_match ON match_participants(match_id);
CREATE INDEX IF NOT EXISTS idx_mp_team ON match_participants(team_id);

-- Raw truth. Every ranking number is computed from these rows.
CREATE TABLE IF NOT EXISTS match_results (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id         INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  placement        INTEGER,
  kills            INTEGER NOT NULL DEFAULT 0,
  placement_points REAL NOT NULL DEFAULT 0,
  kill_points      REAL NOT NULL DEFAULT 0,
  bonus_points     REAL NOT NULL DEFAULT 0,
  penalty_points   REAL NOT NULL DEFAULT 0,
  total_points     REAL NOT NULL DEFAULT 0,
  is_win           INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  recorded_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(match_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_results_match ON match_results(match_id);
CREATE INDEX IF NOT EXISTS idx_results_team ON match_results(team_id);

-- Optional per-player detail; powers MVP / kill leaderboards.
CREATE TABLE IF NOT EXISTS player_stats (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id         INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id        INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kills            INTEGER NOT NULL DEFAULT 0,
  damage           INTEGER NOT NULL DEFAULT 0,
  survival_seconds INTEGER NOT NULL DEFAULT 0,
  UNIQUE(match_id, player_id)
);

-- --------------------------------------------------------- qualification ---
-- Snapshot of a computed cut, written when the organizer locks a stage.
CREATE TABLE IF NOT EXISTS qualifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  stage_id      INTEGER NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,      -- qualified | eliminated
  rank          INTEGER,
  group_rank    INTEGER,
  reason        TEXT,
  computed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(stage_id, team_id)
);

-- ------------------------------------------------- notifications & audit ---
CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = broadcast
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT,
  link          TEXT,
  severity      TEXT NOT NULL DEFAULT 'info',  -- info | success | warning | danger
  channel       TEXT NOT NULL DEFAULT 'web',   -- web | email | telegram | discord | whatsapp
  payload       TEXT,
  delivered_at  TEXT,
  read_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_tournament ON notifications(tournament_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name    TEXT,
  action        TEXT NOT NULL,   -- result.updated | team.created | fixtures.generated
  entity        TEXT,
  entity_id     INTEGER,
  summary       TEXT NOT NULL,
  before_json   TEXT,
  after_json    TEXT,
  ip            TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_tournament ON audit_logs(tournament_id, created_at DESC);

-- ---------------------------------------------------------------- templates --
CREATE TABLE IF NOT EXISTS templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  game        TEXT NOT NULL DEFAULT 'BGMI',
  description TEXT,
  config      TEXT NOT NULL,      -- full tournament + settings payload
  is_system   INTEGER NOT NULL DEFAULT 0,
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

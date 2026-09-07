/** Shared defaults, vocabularies and built-in tournament templates. */

export const ROLES = ['super_admin', 'tournament_admin', 'scorekeeper', 'team_manager', 'spectator'];

export const ROLE_LABELS = {
  super_admin: 'Super Admin',
  tournament_admin: 'Tournament Admin',
  scorekeeper: 'Scorekeeper',
  team_manager: 'Team Manager',
  spectator: 'Spectator',
};

/** Coarse capability model. Route guards ask `can(user, 'results:write')`. */
export const ROLE_ABILITIES = {
  super_admin: ['*'],
  tournament_admin: [
    'tournament:write', 'teams:write', 'fixtures:write', 'matches:write',
    'results:write', 'qualification:write', 'stages:write', 'export', 'audit:read',
    'notifications:write', 'templates:write',
  ],
  scorekeeper: ['results:write', 'matches:status', 'export'],
  team_manager: ['export'],
  spectator: [],
};

export const MATCH_STATUSES = ['upcoming', 'live', 'completed', 'cancelled'];
export const STAGE_KINDS = [
  'group_stage', 'round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'grand_final', 'custom',
];
export const STAGE_LABELS = {
  group_stage: 'Group Stage',
  round_of_32: 'Round of 32',
  round_of_16: 'Round of 16',
  quarter_final: 'Quarter Finals',
  semi_final: 'Semi Finals',
  grand_final: 'Grand Final',
  custom: 'Custom Stage',
};

export const FORMAT_TYPES = {
  battle_royale: 'Battle Royale (points)',
  round_robin: 'Round Robin',
  single_elimination: 'Single Elimination',
  groups_knockout: 'Groups + Knockout',
};

/** Official-style BGMI placement points. */
export const BGMI_PLACEMENT_POINTS = {
  1: 10, 2: 6, 3: 5, 4: 4, 5: 3, 6: 2, 7: 1, 8: 1,
  9: 0, 10: 0, 11: 0, 12: 0, 13: 0, 14: 0, 15: 0, 16: 0,
};

export const DEFAULT_SCORING = {
  placementPoints: { ...BGMI_PLACEMENT_POINTS },
  killPoints: 1,
  winBonus: 0,
  // Teams finishing below the last listed placement score this many points.
  defaultPlacementPoints: 0,
};

/**
 * Ordered tie-breakers. The leaderboard applies them top-down until one
 * separates two teams. Organizers can reorder / trim this list.
 */
export const TIEBREAKER_KEYS = {
  total_points: 'Total points',
  total_kills: 'Total kills',
  best_placement: 'Best placement (WWCD first)',
  wins: 'Number of wins (WWCD)',
  avg_points: 'Average points per match',
  avg_kills: 'Average kills per match',
  last_match_points: 'Most recent match points',
  placement_points: 'Placement points',
  fewest_matches: 'Fewest matches played',
  team_name: 'Team name (A-Z)',
};

export const DEFAULT_TIEBREAKERS = ['total_points', 'total_kills', 'wins', 'best_placement', 'last_match_points'];

export const DEFAULT_QUALIFICATION = {
  mode: 'top_overall',   // top_overall | top_per_group | custom | all
  count: 8,
  perGroup: 3,
  customTeamIds: [],
};

export const DEFAULT_FIXTURE_OPTIONS = {
  mode: 'rotating',      // rotating | static  (battle royale lobby assignment)
  seeded: false,         // honour team seeds instead of drawing at random
  avoidRepeats: true,    // minimise repeated lobby match-ups across rounds
  doubleRoundRobin: false,
  seed: null,            // fixed RNG seed makes a draw reproducible
};

export const DEFAULT_SCHEDULE_OPTIONS = {
  firstMatchTime: '19:00',
  matchGapMinutes: 60,
  matchesPerDay: 4,
  dayBreakMinutes: 0,
};

export const NOTIFICATION_EVENTS = {
  'match.upcoming': 'Upcoming match reminder',
  'match.credentials': 'Room ID / password released',
  'match.started': 'Match started',
  'match.completed': 'Match completed',
  'results.published': 'Results published',
  'team.qualified': 'Team qualified',
  'stage.changed': 'Tournament stage changed',
};

export const DEFAULT_NOTIFICATION_PREFS = {
  events: Object.fromEntries(Object.keys(NOTIFICATION_EVENTS).map((k) => [k, true])),
  channels: { web: true, email: false, telegram: false, discord: false, whatsapp: false },
};

export const DEFAULT_SETTINGS = () => ({
  scoring: structuredClone(DEFAULT_SCORING),
  tiebreakers: [...DEFAULT_TIEBREAKERS],
  qualification: structuredClone(DEFAULT_QUALIFICATION),
  fixture_options: structuredClone(DEFAULT_FIXTURE_OPTIONS),
  schedule_options: structuredClone(DEFAULT_SCHEDULE_OPTIONS),
  notification_prefs: structuredClone(DEFAULT_NOTIFICATION_PREFS),
});

export const MAPS = ['Erangel', 'Miramar', 'Sanhok', 'Vikendi', 'Livik', 'Rondo', 'Karakin'];

/** Built-in templates -- seeded once, then editable/extendable by organizers. */
export const SYSTEM_TEMPLATES = [
  {
    name: 'BGMI 16-Team Single Lobby',
    game: 'BGMI',
    description: '16 teams, one lobby, 6 matches. The standard finals/scrim format.',
    config: {
      tournament: {
        format_type: 'battle_royale', match_format: 'Squad (TPP)',
        num_teams: 16, num_groups: 1, num_rounds: 1, matches_per_round: 6, teams_per_match: 16,
      },
      settings: { qualification: { mode: 'top_overall', count: 8, perGroup: 3, customTeamIds: [] } },
    },
  },
  {
    name: 'BGMI 24-Team Rotating Groups',
    game: 'BGMI',
    description: '24 teams across 2 rotating lobbies, 3 rounds of 4 matches. Top 16 advance.',
    config: {
      tournament: {
        format_type: 'battle_royale', match_format: 'Squad (TPP)',
        num_teams: 24, num_groups: 2, num_rounds: 3, matches_per_round: 4, teams_per_match: 12,
      },
      settings: {
        fixture_options: { mode: 'rotating', seeded: false, avoidRepeats: true, doubleRoundRobin: false, seed: null },
        qualification: { mode: 'top_overall', count: 16, perGroup: 3, customTeamIds: [] },
      },
    },
  },
  {
    name: 'BGMI 32-Team Group Stage',
    game: 'BGMI',
    description: '32 teams in 2 groups of 16, 4 rounds. Top 8 from each group qualify.',
    config: {
      tournament: {
        format_type: 'battle_royale', match_format: 'Squad (TPP)',
        num_teams: 32, num_groups: 2, num_rounds: 4, matches_per_round: 2, teams_per_match: 16,
      },
      settings: {
        fixture_options: { mode: 'static', seeded: true, avoidRepeats: true, doubleRoundRobin: false, seed: null },
        qualification: { mode: 'top_per_group', count: 16, perGroup: 8, customTeamIds: [] },
      },
    },
  },
  {
    name: 'Knockout Bracket (16 Teams)',
    game: 'Valorant',
    description: 'Seeded single-elimination bracket: Ro16, quarters, semis, grand final.',
    config: {
      tournament: {
        format_type: 'single_elimination', match_format: 'Best of 3',
        num_teams: 16, num_groups: 1, num_rounds: 1, matches_per_round: 8, teams_per_match: 2,
      },
      settings: {
        scoring: { placementPoints: { 1: 1, 2: 0 }, killPoints: 0, winBonus: 0, defaultPlacementPoints: 0 },
        tiebreakers: ['wins', 'total_points', 'team_name'],
        fixture_options: { mode: 'static', seeded: true, avoidRepeats: true, doubleRoundRobin: false, seed: null },
        qualification: { mode: 'top_overall', count: 8, perGroup: 1, customTeamIds: [] },
      },
    },
  },
  {
    name: 'Round Robin League (8 Teams)',
    game: 'Football',
    description: 'Every team plays every other once. 3 points a win, 1 a draw.',
    config: {
      tournament: {
        format_type: 'round_robin', match_format: '1 v 1',
        num_teams: 8, num_groups: 1, num_rounds: 7, matches_per_round: 4, teams_per_match: 2,
      },
      settings: {
        scoring: { placementPoints: { 1: 3, 2: 0 }, killPoints: 0, winBonus: 0, defaultPlacementPoints: 0 },
        tiebreakers: ['total_points', 'wins', 'team_name'],
        fixture_options: { mode: 'static', seeded: false, avoidRepeats: true, doubleRoundRobin: false, seed: null },
      },
    },
  },
];

/** Shared defaults, vocabularies and built-in tournament templates. */

export const ROLES = [
  'super_admin', 'organizer', 'tournament_admin', 'scorekeeper', 'team_manager', 'player', 'spectator',
];

export const ROLE_LABELS = {
  super_admin: 'Super Admin',
  organizer: 'Tournament Organizer',
  tournament_admin: 'Tournament Admin',
  scorekeeper: 'Scorekeeper',
  team_manager: 'Team Manager / Captain',
  player: 'Player',
  spectator: 'Spectator',
};

export const ROLE_DESCRIPTIONS = {
  super_admin: 'Full access to everything, including user management.',
  organizer: 'Creates and runs their own tournaments end to end.',
  tournament_admin: 'Manages teams, fixtures, results and settings for assigned tournaments.',
  scorekeeper: 'Enters and edits match results, and moves matches between statuses.',
  team_manager: 'Runs a team: roster, invites and tournament sign-ups.',
  player: 'Joins a team, registers for tournaments and follows their own matches.',
  spectator: 'Read-only access to public pages.',
};

/** Everything a role may be granted. Route guards ask `can(user, 'results:write')`. */
export const ABILITIES = [
  'tournament:create', 'tournament:write', 'teams:write', 'fixtures:write', 'matches:write',
  'matches:status', 'results:write', 'qualification:write', 'stages:write', 'registrations:write',
  'penalties:write', 'rules:write', 'export', 'audit:read', 'notifications:write', 'templates:write',
  'squad:create', 'profile:write',
];

const ORGANISER_ABILITIES = [
  'tournament:write', 'teams:write', 'fixtures:write', 'matches:write', 'matches:status',
  'results:write', 'qualification:write', 'stages:write', 'registrations:write',
  'penalties:write', 'rules:write', 'export', 'audit:read', 'notifications:write',
  'templates:write', 'squad:create', 'profile:write',
];

/** Coarse capability model. */
export const ROLE_ABILITIES = {
  super_admin: ['*'],
  organizer: ['tournament:create', ...ORGANISER_ABILITIES],
  tournament_admin: ORGANISER_ABILITIES,
  scorekeeper: ['results:write', 'matches:status', 'export', 'profile:write'],
  team_manager: ['export', 'squad:create', 'profile:write'],
  player: ['squad:create', 'profile:write'],
  spectator: [],
};

/** Roles allowed to start a brand new tournament. */
export const CAN_CREATE_TOURNAMENTS = ['super_admin', 'organizer', 'tournament_admin'];

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
  'registration.received': 'Registration submitted',
  'registration.approved': 'Registration confirmed',
  'registration.rejected': 'Registration rejected',
  'checkin.open': 'Check-in opened',
  'tournament.started': 'Tournament starting',
  'fixtures.generated': 'Fixtures generated',
  'match.upcoming': 'Upcoming match reminder',
  'match.credentials': 'Room ID / password released',
  'match.started': 'Match started',
  'match.completed': 'Match completed',
  'results.published': 'Results published',
  'team.qualified': 'Team qualified',
  'team.eliminated': 'Team eliminated',
  'penalty.applied': 'Penalty or disqualification applied',
  'stage.changed': 'Tournament stage changed',
  'tournament.completed': 'Tournament completed',
  'squad.invite': 'Team invitation',
};

/** When room credentials become visible to registered participants. */
export const REVEAL_POLICIES = {
  manual: 'Manually reveal',
  immediate: 'Immediately',
  minutes: 'A set time before the match',
};
export const REVEAL_MINUTE_CHOICES = [5, 10, 15, 30, 60];

export const REGISTRATION_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'];
export const SQUAD_MEMBER_ROLES = ['captain', 'player', 'substitute'];

/** Built-in scoring systems, seeded into `scoring_presets`. */
export const SYSTEM_SCORING_PRESETS = [
  {
    name: 'BGMI Standard',
    game: 'BGMI',
    description: 'Official BGMI points: 10/6/5/4/3/2/1/1 placement, 1 point per kill.',
    config: {
      scoring: {
        placementPoints: { 1: 10, 2: 6, 3: 5, 4: 4, 5: 3, 6: 2, 7: 1, 8: 1, 9: 0, 10: 0, 11: 0, 12: 0, 13: 0, 14: 0, 15: 0, 16: 0 },
        killPoints: 1, winBonus: 0, defaultPlacementPoints: 0,
      },
      tiebreakers: ['total_points', 'total_kills', 'wins', 'best_placement', 'last_match_points'],
    },
  },
  {
    name: 'BGMI Classic (15/12/10)',
    game: 'BGMI',
    description: 'Older scrim format with a heavier weighting on placement.',
    config: {
      scoring: {
        placementPoints: { 1: 15, 2: 12, 3: 10, 4: 8, 5: 6, 6: 4, 7: 2, 8: 1, 9: 0, 10: 0, 11: 0, 12: 0, 13: 0, 14: 0, 15: 0, 16: 0 },
        killPoints: 1, winBonus: 0, defaultPlacementPoints: 0,
      },
      tiebreakers: ['total_points', 'total_kills', 'best_placement', 'wins'],
    },
  },
  {
    name: 'Kills Only',
    game: 'BGMI',
    description: 'Every kill counts, placement is ignored. Good for TDM and warm-up lobbies.',
    config: {
      scoring: { placementPoints: { 1: 0 }, killPoints: 1, winBonus: 0, defaultPlacementPoints: 0 },
      tiebreakers: ['total_kills', 'total_points', 'wins'],
    },
  },
  {
    name: 'TDM (Round Wins)',
    game: 'BGMI',
    description: 'Team deathmatch: 1 point a win, kills tracked but unscored.',
    config: {
      scoring: { placementPoints: { 1: 1, 2: 0 }, killPoints: 0, winBonus: 0, defaultPlacementPoints: 0 },
      tiebreakers: ['total_points', 'wins', 'total_kills'],
    },
  },
];

export const GAMES = ['BGMI', 'PUBG Mobile', 'Free Fire', 'Valorant', 'CS2', 'Call of Duty Mobile', 'Apex Legends'];

export const REGIONS = [
  'India', 'South Asia', 'Southeast Asia', 'Middle East', 'Europe',
  'North America', 'South America', 'Africa', 'Oceania', 'Global',
];

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

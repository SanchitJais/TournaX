/**
 * Fixture generation.
 *
 * Pure functions: they take teams + a format description and return a plain
 * fixture plan. Nothing here touches the database, which keeps the scheduling
 * logic testable and lets the UI preview a draw before committing it.
 */

// ------------------------------------------------------------------- random --
/** Deterministic PRNG so a draw can be reproduced from its seed. */
export function makeRng(seed) {
  if (seed === null || seed === undefined) seed = (Math.random() * 2 ** 32) >>> 0;
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.seed = seed;
  return rng;
}

export function shuffle(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ------------------------------------------------------------ group drawing --
/**
 * Distribute teams across groups.
 *
 * Seeded draws use a snake pattern (1->A, 2->B, 3->B, 4->A ...) so seeding
 * strength is spread evenly instead of stacking the top seeds into one group.
 */
export function distributeGroups(teams, numGroups, { seeded = false, rng } = {}) {
  const count = Math.max(1, Math.min(numGroups || 1, teams.length || 1));
  const groups = Array.from({ length: count }, () => []);
  if (!teams.length) return groups;

  const ordered = seeded
    ? [...teams].sort((a, b) => (a.seed ?? 9999) - (b.seed ?? 9999) || a.id - b.id)
    : shuffle(teams, rng);

  ordered.forEach((team, i) => {
    const row = Math.floor(i / count);
    const col = i % count;
    // Snake: reverse direction on odd rows.
    groups[row % 2 === 0 ? col : count - 1 - col].push(team);
  });
  return groups;
}

// -------------------------------------------------- repeat-aware lobby draw --
const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** Total number of previous encounters inside the proposed lobbies. */
function partitionCost(lobbies, history) {
  let cost = 0;
  for (const lobby of lobbies) {
    for (let i = 0; i < lobby.length; i++) {
      for (let j = i + 1; j < lobby.length; j++) {
        cost += history.get(pairKey(lobby[i].id, lobby[j].id)) || 0;
      }
    }
  }
  return cost;
}

/**
 * Split teams into `lobbyCount` near-equal lobbies while meeting as many new
 * opponents as possible. Randomised restarts followed by steepest-descent
 * swapping; for realistic sizes (<= ~128 teams) this lands on an optimal or
 * near-optimal split in milliseconds.
 */
export function drawLobbies(teams, lobbyCount, history, rng, {
  restarts = 12, seedPartition = null, deadline = Infinity,
} = {}) {
  if (lobbyCount <= 1) return [[...teams]];

  const sizes = balancedSizes(teams.length, lobbyCount);
  let best = null;
  let bestCost = Infinity;

  for (let attempt = -1; attempt < restarts; attempt++) {
    // Always finish the seeded attempt so a polish pass has something to return.
    if (attempt > 0 && Date.now() > deadline) break;
    // Attempt -1 refines the caller's existing split, so polishing an already
    // good draw can never make it worse.
    let lobbies;
    if (attempt === -1) {
      if (!seedPartition) continue;
      lobbies = seedPartition.map((lobby) => [...lobby]);
    } else {
      const pool = shuffle(teams, rng);
      lobbies = [];
      let cursor = 0;
      for (const size of sizes) {
        lobbies.push(pool.slice(cursor, cursor + size));
        cursor += size;
      }
    }

    let cost = partitionCost(lobbies, history);
    let improved = true;
    let guard = 0;
    while (improved && cost > 0 && guard++ < 200) {
      improved = false;
      outer:
      for (let a = 0; a < lobbies.length; a++) {
        for (let b = a + 1; b < lobbies.length; b++) {
          for (let i = 0; i < lobbies[a].length; i++) {
            for (let j = 0; j < lobbies[b].length; j++) {
              const delta = swapDelta(lobbies[a], lobbies[b], i, j, history);
              if (delta < 0) {
                const tmp = lobbies[a][i];
                lobbies[a][i] = lobbies[b][j];
                lobbies[b][j] = tmp;
                cost += delta;
                improved = true;
                continue outer;
              }
            }
          }
        }
      }
    }

    if (cost < bestCost) { bestCost = cost; best = lobbies; }
    if (bestCost === 0) break;      // nobody repeats -- cannot do better
  }
  return best;
}

/** Change in cost from exchanging one member of lobby A with one of lobby B. */
function swapDelta(lobbyA, lobbyB, i, j, history) {
  const teamA = lobbyA[i];
  const teamB = lobbyB[j];
  let delta = 0;
  for (let k = 0; k < lobbyA.length; k++) {
    if (k === i) continue;
    delta -= history.get(pairKey(teamA.id, lobbyA[k].id)) || 0;
    delta += history.get(pairKey(teamB.id, lobbyA[k].id)) || 0;
  }
  for (let k = 0; k < lobbyB.length; k++) {
    if (k === j) continue;
    delta -= history.get(pairKey(teamB.id, lobbyB[k].id)) || 0;
    delta += history.get(pairKey(teamA.id, lobbyB[k].id)) || 0;
  }
  return delta;
}

/** e.g. 26 teams over 3 lobbies -> [9, 9, 8] */
function balancedSizes(total, buckets) {
  const base = Math.floor(total / buckets);
  const remainder = total % buckets;
  return Array.from({ length: buckets }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** Add (or, with a negative delta, retract) a round's meetings from history. */
function applyEncounters(lobbies, history, delta) {
  for (const lobby of lobbies) {
    for (let i = 0; i < lobby.length; i++) {
      for (let j = i + 1; j < lobby.length; j++) {
        const key = pairKey(lobby[i].id, lobby[j].id);
        const next = (history.get(key) || 0) + delta;
        if (next <= 0) history.delete(key);
        else history.set(key, next);
      }
    }
  }
}

/**
 * Drawing round by round locks in early choices that later rounds then have to
 * work around. This sweeps back over each round in turn, lifts its own
 * meetings out of the history, and re-draws it against every *other* round --
 * repeating until nothing improves. It is what turns a merely decent rotation
 * into one where almost no team meets the same opponent a third time.
 */
function polishRounds({ roundLobbies, history, teams, lobbyCount, weight, rng, sweeps = 8, deadline = Infinity }) {
  if (lobbyCount <= 1 || roundLobbies.length < 2) return;

  for (let sweep = 0; sweep < sweeps; sweep++) {
    let improved = false;
    for (let r = 0; r < roundLobbies.length; r++) {
      if (Date.now() > deadline) return;
      applyEncounters(roundLobbies[r], history, -weight);
      const before = partitionCost(roundLobbies[r], history);
      const candidate = drawLobbies(teams, lobbyCount, history, rng, {
        restarts: 10,
        seedPartition: roundLobbies[r],
        deadline,
      });
      if (partitionCost(candidate, history) < before) {
        roundLobbies[r] = candidate;
        improved = true;
      }
      applyEncounters(roundLobbies[r], history, weight);
    }
    if (!improved) break;
  }
}

// ------------------------------------------------------------- bracket seed --
/**
 * Standard bracket ordering: 1 plays the lowest seed, and the top two seeds
 * can only meet in the final. Returns seed numbers for a 2^k bracket.
 */
export function bracketSeedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    const next = [];
    for (const seed of order) { next.push(seed, n + 1 - seed); }
    order = next;
  }
  return order;
}

const nextPowerOfTwo = (n) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

// ---------------------------------------------------------------- schedule ---
/**
 * Walk match slots forward from the start date, inserting a day break after
 * `matchesPerDay`. Returns ISO-like local timestamps ("YYYY-MM-DD HH:MM").
 */
export function buildSchedule(count, { startDate, firstMatchTime = '19:00', matchGapMinutes = 60, matchesPerDay = 4 }) {
  const [hh, mm] = String(firstMatchTime || '19:00').split(':').map(Number);
  const base = startDate ? new Date(`${String(startDate).slice(0, 10)}T00:00:00`) : new Date();
  if (Number.isNaN(base.getTime())) base.setTime(Date.now());

  const perDay = Math.max(1, matchesPerDay || count || 1);
  const out = [];
  for (let i = 0; i < count; i++) {
    const day = Math.floor(i / perDay);
    const slot = i % perDay;
    const when = new Date(base);
    when.setDate(when.getDate() + day);
    when.setHours(hh || 19, mm || 0, 0, 0);
    when.setMinutes(when.getMinutes() + slot * (matchGapMinutes || 60));
    out.push(formatLocal(when));
  }
  return out;
}

const pad = (n) => String(n).padStart(2, '0');
export const formatLocal = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// ============================================================== main entry ===
/**
 * Produce a fixture plan.
 *
 * @param {object} input
 * @param {Array<{id:number,name:string,seed?:number}>} input.teams
 * @param {string} input.formatType battle_royale | round_robin | single_elimination | groups_knockout
 * @param {number} input.numGroups
 * @param {number} input.numRounds
 * @param {number} input.matchesPerRound  total matches in a round, across lobbies
 * @param {number} input.teamsPerMatch
 * @param {object} input.options  DEFAULT_FIXTURE_OPTIONS shape
 * @param {object} input.schedule DEFAULT_SCHEDULE_OPTIONS shape + startDate
 * @returns {{groups: Array, rounds: Array, matches: Array, warnings: string[], seed: number}}
 */
export function generateFixtures(input) {
  const {
    teams, formatType = 'battle_royale', numGroups = 1, numRounds = 1,
    matchesPerRound = 1, teamsPerMatch = 16, options = {}, schedule = {},
  } = input;

  if (!teams?.length) {
    return { groups: [], rounds: [], matches: [], warnings: ['Add teams before generating fixtures.'], seed: 0 };
  }

  const rng = makeRng(options.seed ?? null);
  const warnings = [];

  const plan = formatType === 'single_elimination'
    ? planKnockout({ teams, options, rng, warnings })
    : formatType === 'round_robin'
      ? planRoundRobin({ teams, numGroups, numRounds, options, rng, warnings })
      : planBattleRoyale({
        teams, numGroups, numRounds, matchesPerRound, teamsPerMatch, options, rng, warnings,
      });

  // Number matches globally and hang timestamps off them.
  const times = buildSchedule(plan.matches.length, schedule);
  plan.matches.forEach((match, i) => {
    match.match_no = i + 1;
    match.scheduled_at = times[i];
  });

  return { ...plan, warnings: [...warnings, ...(plan.warnings || [])], seed: rng.seed };
}

// -------------------------------------------------------------- battle royale
function planBattleRoyale({ teams, numGroups, numRounds, matchesPerRound, teamsPerMatch, options, rng, warnings }) {
  const perMatch = Math.max(2, Math.min(teamsPerMatch || teams.length, teams.length));
  const lobbyCount = Math.max(1, Math.ceil(teams.length / perMatch));
  const rounds = Math.max(1, numRounds || 1);
  const totalPerRound = Math.max(1, matchesPerRound || lobbyCount);
  const matchesPerLobby = Math.max(1, Math.round(totalPerRound / lobbyCount));

  const staticMode = options.mode === 'static';
  const history = new Map();

  // Groups are the persistent identity in static mode; in rotating mode we
  // still declare them so the standings can be split by group if wanted.
  const groupCount = staticMode ? Math.max(1, numGroups || lobbyCount) : lobbyCount;
  const baseGroups = distributeGroups(teams, groupCount, { seeded: options.seeded, rng });

  if (staticMode && groupCount !== lobbyCount) {
    warnings.push(
      `${teams.length} teams across ${groupCount} group(s) does not divide evenly into lobbies of ${perMatch}; `
      + 'group sizes were balanced automatically.',
    );
  }

  const groups = baseGroups.map((members, i) => ({
    name: `Group ${String.fromCharCode(65 + i)}`,
    order_index: i,
    teamIds: members.map((t) => t.id),
  }));

  // Draw every round first, then polish the whole set together. Both phases
  // share one wall-clock budget so a 100-team draw still returns promptly.
  const deadline = Date.now() + (options.budgetMs ?? 700);
  const roundLobbies = [];
  for (let r = 0; r < rounds; r++) {
    if (staticMode) {
      roundLobbies.push(baseGroups);
    } else {
      const lobbies = drawLobbies(teams, lobbyCount, history, rng, { deadline });
      applyEncounters(lobbies, history, matchesPerLobby);
      roundLobbies.push(lobbies);
    }
  }
  if (!staticMode) {
    polishRounds({
      roundLobbies, history, teams, lobbyCount, weight: matchesPerLobby, rng, deadline,
    });
  }

  const roundPlans = [];
  const matches = [];
  roundLobbies.forEach((lobbies, r) => {
    roundPlans.push({ name: `Round ${r + 1}`, order_index: r });
    lobbies.forEach((lobby, lobbyIndex) => {
      if (!lobby.length) return;
      for (let m = 0; m < matchesPerLobby; m++) {
        matches.push({
          roundIndex: r,
          groupIndex: staticMode ? lobbyIndex : (lobbyCount > 1 ? lobbyIndex : 0),
          label: lobbyCount > 1
            ? `Round ${r + 1} - Lobby ${String.fromCharCode(65 + lobbyIndex)} - Match ${m + 1}`
            : `Round ${r + 1} - Match ${m + 1}`,
          teamIds: lobby.map((t) => t.id),
        });
      }
    });
  });

  if (!staticMode && lobbyCount > 1) {
    const thirdMeetings = [...history.values()].filter((v) => v > 2 * matchesPerLobby).length;
    if (thirdMeetings === 0) {
      warnings.push('Rotating draw complete: no team meets the same opponent more than twice.');
    }
  }
  if (teams.length % perMatch !== 0 && lobbyCount > 1) {
    warnings.push(`${teams.length} teams do not fill lobbies of ${perMatch} exactly, so lobby sizes differ by one team.`);
  }

  return { groups, rounds: roundPlans, matches };
}

// ---------------------------------------------------------------- round robin
function planRoundRobin({ teams, numGroups, numRounds, options, rng, warnings }) {
  const groupsOfTeams = distributeGroups(teams, Math.max(1, numGroups || 1), { seeded: options.seeded, rng });
  const groups = groupsOfTeams.map((members, i) => ({
    name: `Group ${String.fromCharCode(65 + i)}`,
    order_index: i,
    teamIds: members.map((t) => t.id),
  }));

  // Circle method per group; rounds are shared across groups so matchday N
  // means the same thing everywhere.
  const perGroupRounds = groupsOfTeams.map((members) => circleMethod(members, options.doubleRoundRobin));
  const maxRounds = Math.max(0, ...perGroupRounds.map((r) => r.length));
  const cap = numRounds > 0 ? Math.min(numRounds, maxRounds) : maxRounds;
  if (numRounds > maxRounds) {
    warnings.push(`A full round robin needs only ${maxRounds} round(s); the extra rounds were dropped.`);
  }

  const rounds = Array.from({ length: cap }, (_, i) => ({ name: `Matchday ${i + 1}`, order_index: i }));
  const matches = [];
  for (let r = 0; r < cap; r++) {
    perGroupRounds.forEach((groupRounds, gi) => {
      for (const [home, away] of groupRounds[r] || []) {
        matches.push({
          roundIndex: r,
          groupIndex: gi,
          label: `${home.name} vs ${away.name}`,
          teamIds: [home.id, away.id],
        });
      }
    });
  }
  return { groups, rounds, matches };
}

/** Berger/circle pairings; returns an array of rounds of [teamA, teamB]. */
function circleMethod(teams, doubleRound = false) {
  const list = [...teams];
  const bye = list.length % 2 === 1;
  if (bye) list.push(null);

  const n = list.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a && b) pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    // Rotate everything but the first entry.
    list.splice(1, 0, list.pop());
  }
  if (doubleRound) {
    const reversed = rounds.map((pairs) => pairs.map(([a, b]) => [b, a]));
    return [...rounds, ...reversed];
  }
  return rounds;
}

// ------------------------------------------------------------------ knockout
function planKnockout({ teams, options, rng, warnings }) {
  const ordered = options.seeded
    ? [...teams].sort((a, b) => (a.seed ?? 9999) - (b.seed ?? 9999) || a.id - b.id)
    : shuffle(teams, rng);

  const size = nextPowerOfTwo(ordered.length);
  const byes = size - ordered.length;
  if (byes > 0) warnings.push(`${byes} team(s) receive a first-round bye to fill a ${size}-team bracket.`);

  const order = bracketSeedOrder(size);
  const matches = [];
  for (let i = 0; i < order.length; i += 2) {
    const a = ordered[order[i] - 1] || null;
    const b = ordered[order[i + 1] - 1] || null;
    if (!a && !b) continue;
    matches.push({
      roundIndex: 0,
      groupIndex: 0,
      label: a && b ? `${a.name} vs ${b.name}` : `${(a || b).name} - bye`,
      teamIds: [a, b].filter(Boolean).map((t) => t.id),
    });
  }

  return {
    groups: [{ name: 'Bracket', order_index: 0, teamIds: ordered.map((t) => t.id) }],
    rounds: [{ name: roundNameFor(size), order_index: 0 }],
    matches,
  };
}

function roundNameFor(size) {
  if (size <= 2) return 'Grand Final';
  if (size === 4) return 'Semi Finals';
  if (size === 8) return 'Quarter Finals';
  return `Round of ${size}`;
}

export { roundNameFor, circleMethod, nextPowerOfTwo };

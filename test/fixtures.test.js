import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateFixtures, distributeGroups, bracketSeedOrder, buildSchedule, makeRng, circleMethod,
} from '../src/services/fixtures.js';

const makeTeams = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Team ${i + 1}`, seed: i + 1 }));

const base = {
  schedule: { startDate: '2026-09-10', firstMatchTime: '19:00', matchGapMinutes: 60, matchesPerDay: 4 },
};

test('single lobby: every match contains all teams', () => {
  const out = generateFixtures({
    ...base,
    teams: makeTeams(16),
    formatType: 'battle_royale',
    numGroups: 1, numRounds: 1, matchesPerRound: 6, teamsPerMatch: 16,
    options: { mode: 'rotating', seed: 7 },
  });
  assert.equal(out.matches.length, 6);
  for (const m of out.matches) assert.equal(m.teamIds.length, 16);
  assert.deepEqual(out.matches.map((m) => m.match_no), [1, 2, 3, 4, 5, 6]);
});

test('rotating lobbies spread opponents and keep lobbies balanced', () => {
  const teams = makeTeams(24);
  const out = generateFixtures({
    ...base,
    teams,
    formatType: 'battle_royale',
    numGroups: 2, numRounds: 3, matchesPerRound: 2, teamsPerMatch: 12,
    options: { mode: 'rotating', avoidRepeats: true, seed: 42 },
  });

  assert.equal(out.matches.length, 6, '3 rounds x 2 lobbies x 1 match');
  for (const m of out.matches) assert.equal(m.teamIds.length, 12);

  // Each team appears in exactly one lobby per round.
  for (let r = 0; r < 3; r++) {
    const inRound = out.matches.filter((m) => m.roundIndex === r).flatMap((m) => m.teamIds);
    assert.equal(inRound.length, 24);
    assert.equal(new Set(inRound).size, 24, `round ${r} must contain every team once`);
  }

  // Quality bar: total excess meetings, sum over pairs of C(meetings, 2).
  //
  // Every team's lobby across 3 rounds is a 3-bit signature, and two teams meet
  // once per position where their signatures agree. With 8 signatures and 24
  // teams the balanced assignment is 3 teams each, which yields exactly
  // 108 pairs meeting twice + 24 meeting three times = cost 180. No schedule
  // can beat that, so the draw must reach it.
  assert.equal(excessCost(out.matches), 180, 'rotation should hit the optimal spread');
});

/** Sum over team pairs of C(times they shared a lobby, 2). Lower is fairer. */
function excessCost(matches) {
  const seen = new Map();
  for (const m of matches) {
    for (let i = 0; i < m.teamIds.length; i++) {
      for (let j = i + 1; j < m.teamIds.length; j++) {
        const key = [m.teamIds[i], m.teamIds[j]].sort((a, b) => a - b).join(':');
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    }
  }
  return [...seen.values()].reduce((acc, k) => acc + (k * (k - 1)) / 2, 0);
}

test('rotation reaches the optimal spread for 32 teams over 4 rounds', () => {
  // 16 signatures, 2 teams each: 16 pairs meet 4x, 128 meet 3x, 192 meet 2x
  // => cost 16*6 + 128*3 + 192*1 = 672.
  for (const seed of [1, 2, 3]) {
    const out = generateFixtures({
      ...base,
      teams: makeTeams(32),
      formatType: 'battle_royale',
      numGroups: 2, numRounds: 4, matchesPerRound: 2, teamsPerMatch: 16,
      options: { mode: 'rotating', avoidRepeats: true, seed },
    });
    assert.equal(excessCost(out.matches), 672, `seed ${seed} fell short of the optimum`);
  }
});

test('a large draw still returns inside its time budget', () => {
  const started = Date.now();
  const out = generateFixtures({
    ...base,
    teams: makeTeams(100),
    formatType: 'battle_royale',
    numGroups: 5, numRounds: 5, matchesPerRound: 5, teamsPerMatch: 20,
    options: { mode: 'rotating', seed: 3, budgetMs: 400 },
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `took ${elapsed}ms`);
  assert.equal(out.matches.length, 25);
  for (let r = 0; r < 5; r++) {
    const ids = out.matches.filter((m) => m.roundIndex === r).flatMap((m) => m.teamIds);
    assert.equal(new Set(ids).size, 100, `round ${r + 1} must place every team exactly once`);
  }
});

test('static mode keeps the same groups every round', () => {
  const out = generateFixtures({
    ...base,
    teams: makeTeams(32),
    formatType: 'battle_royale',
    numGroups: 2, numRounds: 4, matchesPerRound: 2, teamsPerMatch: 16,
    options: { mode: 'static', seeded: true },
  });
  assert.equal(out.matches.length, 8);
  const groupA = out.matches.filter((m) => m.groupIndex === 0);
  const signature = JSON.stringify([...groupA[0].teamIds].sort((a, b) => a - b));
  for (const m of groupA) {
    assert.equal(JSON.stringify([...m.teamIds].sort((a, b) => a - b)), signature);
  }
});

test('snake seeding balances group strength', () => {
  const groups = distributeGroups(makeTeams(16), 4, { seeded: true });
  assert.deepEqual(groups.map((g) => g.length), [4, 4, 4, 4]);
  const sums = groups.map((g) => g.reduce((acc, t) => acc + t.seed, 0));
  // A snake draw gives every group an identical seed total for 16/4.
  assert.equal(new Set(sums).size, 1, `group seed sums should match, got ${sums}`);
});

test('round robin: everyone plays everyone exactly once', () => {
  const out = generateFixtures({
    ...base,
    teams: makeTeams(8),
    formatType: 'round_robin',
    numGroups: 1, numRounds: 7, matchesPerRound: 4, teamsPerMatch: 2,
    options: { seeded: true },
  });
  assert.equal(out.rounds.length, 7);
  assert.equal(out.matches.length, 28, 'C(8,2) = 28');

  const pairs = new Set(out.matches.map((m) => [...m.teamIds].sort((a, b) => a - b).join(':')));
  assert.equal(pairs.size, 28, 'no pair repeats');

  // And no team is scheduled twice on the same matchday.
  for (let r = 0; r < 7; r++) {
    const ids = out.matches.filter((m) => m.roundIndex === r).flatMap((m) => m.teamIds);
    assert.equal(new Set(ids).size, ids.length, `matchday ${r + 1} double-books a team`);
  }
});

test('round robin handles an odd team count with byes', () => {
  const rounds = circleMethod(makeTeams(7));
  assert.equal(rounds.length, 7);
  const pairs = rounds.flat();
  assert.equal(pairs.length, 21, 'C(7,2) = 21');
  for (const round of rounds) assert.equal(round.length, 3, 'one team sits out each round');
});

test('bracket seeding pairs strongest against weakest', () => {
  assert.deepEqual(bracketSeedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  const out = generateFixtures({
    ...base,
    teams: makeTeams(16),
    formatType: 'single_elimination',
    numGroups: 1, numRounds: 1, matchesPerRound: 8, teamsPerMatch: 2,
    options: { seeded: true },
  });
  assert.equal(out.matches.length, 8);
  assert.deepEqual(out.matches[0].teamIds, [1, 16]);
  assert.deepEqual(out.matches[1].teamIds, [8, 9]);
  assert.equal(out.rounds[0].name, 'Round of 16');
});

test('bracket gives byes when the field is not a power of two', () => {
  const out = generateFixtures({
    ...base,
    teams: makeTeams(12),
    formatType: 'single_elimination',
    numGroups: 1, numRounds: 1, matchesPerRound: 8, teamsPerMatch: 2,
    options: { seeded: true },
  });
  const byes = out.matches.filter((m) => m.teamIds.length === 1);
  assert.equal(byes.length, 4);
  assert.ok(out.warnings.some((w) => w.includes('bye')));
});

test('schedule advances by the gap and rolls over to the next day', () => {
  const times = buildSchedule(6, {
    startDate: '2026-09-10', firstMatchTime: '19:00', matchGapMinutes: 60, matchesPerDay: 4,
  });
  assert.equal(times[0], '2026-09-10 19:00');
  assert.equal(times[3], '2026-09-10 22:00');
  assert.equal(times[4], '2026-09-11 19:00', 'match 5 starts the next day');
});

test('the same seed reproduces the same draw', () => {
  const args = {
    ...base,
    teams: makeTeams(24),
    formatType: 'battle_royale',
    numGroups: 2, numRounds: 3, matchesPerRound: 2, teamsPerMatch: 12,
    options: { mode: 'rotating', seed: 12345 },
  };
  const a = generateFixtures(args);
  const b = generateFixtures(args);
  assert.deepEqual(a.matches.map((m) => m.teamIds), b.matches.map((m) => m.teamIds));

  const c = generateFixtures({ ...args, options: { ...args.options, seed: 999 } });
  assert.notDeepEqual(a.matches.map((m) => m.teamIds), c.matches.map((m) => m.teamIds));
});

test('generating with no teams reports a warning instead of throwing', () => {
  const out = generateFixtures({ ...base, teams: [], formatType: 'battle_royale' });
  assert.equal(out.matches.length, 0);
  assert.match(out.warnings[0], /Add teams/);
});

test('uneven team counts still balance lobbies to within one team', () => {
  const out = generateFixtures({
    ...base,
    teams: makeTeams(26),
    formatType: 'battle_royale',
    numGroups: 2, numRounds: 2, matchesPerRound: 3, teamsPerMatch: 9,
    options: { mode: 'rotating', seed: 5 },
  });
  const round0 = out.matches.filter((m) => m.roundIndex === 0);
  const sizes = round0.map((m) => m.teamIds.length).sort();
  assert.equal(sizes.reduce((a, b) => a + b, 0), 26);
  assert.ok(sizes[sizes.length - 1] - sizes[0] <= 1, `lobby sizes ${sizes} differ by more than one`);
});

test('rng is deterministic for a given seed', () => {
  const a = makeRng(2024);
  const b = makeRng(2024);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

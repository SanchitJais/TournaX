/**
 * Bridges the pure fixture planner to the database: draws a plan, writes
 * groups / rounds / matches / participants, and keeps match numbering tidy.
 */
import { all, get, insert, run, tx, parseJson } from '../db.js';
import { generateFixtures } from './fixtures.js';
import { DEFAULT_FIXTURE_OPTIONS, DEFAULT_SCHEDULE_OPTIONS, MAPS } from '../config.js';
import { recordAudit } from './audit.js';
import { notify } from './notify.js';

/** Matches are numbered 1..N across the whole tournament, in playing order. */
export function renumberMatches(tournamentId) {
  const ordered = all(
    `SELECT m.id FROM matches m
       JOIN stages s ON s.id = m.stage_id
       LEFT JOIN rounds r ON r.id = m.round_id
      WHERE m.tournament_id = ?
      ORDER BY s.order_index, COALESCE(r.order_index, 0), m.scheduled_at, m.id`,
    [tournamentId],
  );
  ordered.forEach((row, i) => run('UPDATE matches SET match_no = ? WHERE id = ?', [i + 1, row.id]));
  return ordered.length;
}

export const stageResultCount = (stageId) =>
  get(
    `SELECT COUNT(*) AS n FROM match_results r JOIN matches m ON m.id = r.match_id WHERE m.stage_id = ?`,
    [stageId],
  ).n;

/**
 * Draw and store fixtures for one stage.
 *
 * @param {object} args
 * @param {object} args.tournament
 * @param {object} args.settings   raw tournament_settings row
 * @param {object} args.stage
 * @param {object[]} args.teams    teams taking part in this stage
 * @param {object} [args.overrides] fixture option overrides for this draw
 * @param {object} [args.actor]
 * @returns {{ plan, matches: number, warnings: string[], seed: number }}
 */
export function generateStageFixtures({ tournament, settings, stage, teams, overrides = {}, actor }) {
  const fixtureOptions = {
    ...DEFAULT_FIXTURE_OPTIONS,
    ...parseJson(settings?.fixture_options, {}),
    ...overrides,
  };
  const scheduleOptions = {
    ...DEFAULT_SCHEDULE_OPTIONS,
    ...parseJson(settings?.schedule_options, {}),
    startDate: overrides.startDate || stage.start_date || tournament.start_date,
  };

  const plan = generateFixtures({
    teams,
    formatType: overrides.formatType || tournament.format_type,
    numGroups: stage.num_groups || tournament.num_groups,
    numRounds: stage.num_rounds || tournament.num_rounds,
    matchesPerRound: stage.matches_per_round || tournament.matches_per_round,
    teamsPerMatch: stage.teams_per_match || tournament.teams_per_match,
    options: fixtureOptions,
    schedule: scheduleOptions,
  });

  const existingResults = stageResultCount(stage.id);

  tx(() => {
    // Regenerating replaces the stage's schedule outright; cascades clear
    // participants and any results attached to the old matches.
    run('DELETE FROM matches WHERE stage_id = ?', [stage.id]);
    run('DELETE FROM rounds WHERE stage_id = ?', [stage.id]);
    run('UPDATE teams SET group_id = NULL WHERE group_id IN (SELECT id FROM groups WHERE stage_id = ?)', [stage.id]);
    run('DELETE FROM groups WHERE stage_id = ?', [stage.id]);

    const groupIds = plan.groups.map((group) => {
      const id = insert(
        'INSERT INTO groups (tournament_id, stage_id, name, order_index) VALUES (?, ?, ?, ?)',
        [tournament.id, stage.id, group.name, group.order_index],
      );
      for (const teamId of group.teamIds) {
        run('UPDATE teams SET group_id = ? WHERE id = ?', [id, teamId]);
      }
      return id;
    });

    const roundIds = plan.rounds.map((round) => insert(
      'INSERT INTO rounds (tournament_id, stage_id, name, order_index) VALUES (?, ?, ?, ?)',
      [tournament.id, stage.id, round.name, round.order_index],
    ));

    const useMaps = tournament.format_type === 'battle_royale';
    plan.matches.forEach((match, index) => {
      const matchId = insert(
        `INSERT INTO matches (tournament_id, stage_id, round_id, group_id, match_no, label, map, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'upcoming')`,
        [
          tournament.id,
          stage.id,
          roundIds[match.roundIndex] ?? null,
          groupIds[match.groupIndex] ?? null,
          match.match_no,
          match.label,
          useMaps ? MAPS[index % MAPS.length] : null,
          match.scheduled_at,
        ],
      );
      match.teamIds.forEach((teamId, slot) => {
        insert('INSERT INTO match_participants (match_id, team_id, slot) VALUES (?, ?, ?)', [matchId, teamId, slot]);
      });
    });

    run("UPDATE stages SET status = 'live' WHERE id = ? AND status = 'pending'", [stage.id]);
    renumberMatches(tournament.id);
  });

  const warnings = [...plan.warnings];
  if (existingResults) {
    warnings.unshift(`${existingResults} previously recorded result row(s) were discarded with the old schedule.`);
  }

  recordAudit({
    tournamentId: tournament.id,
    actor,
    action: 'fixtures.generated',
    entity: 'stage',
    entityId: stage.id,
    summary: `Generated ${plan.matches.length} match(es) for ${stage.name} across ${plan.rounds.length} round(s) and ${plan.groups.length} group(s).`,
    after: { seed: plan.seed, options: fixtureOptions },
  });

  notify({
    tournamentId: tournament.id,
    type: 'stage.changed',
    title: `Fixtures published for ${stage.name}`,
    body: `${plan.matches.length} matches scheduled.`,
    severity: 'info',
    link: `/admin/tournaments/${tournament.id}/fixtures`,
  });

  return { plan, matches: plan.matches.length, warnings, seed: plan.seed };
}

/** Teams eligible for a stage: those carried in, else the whole roster. */
export function stageTeams(tournamentId, stage) {
  if (stage.source_stage_id) {
    const rows = all(
      `SELECT t.* FROM qualifications q JOIN teams t ON t.id = q.team_id
        WHERE q.stage_id = ? AND q.status = 'qualified' ORDER BY q.rank`,
      [stage.source_stage_id],
    );
    if (rows.length) return rows.map((t, i) => ({ ...t, seed: t.seed ?? i + 1 }));
  }
  return all('SELECT * FROM teams WHERE tournament_id = ? ORDER BY COALESCE(seed, 9999), name', [tournamentId]);
}

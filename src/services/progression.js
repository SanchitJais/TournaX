/**
 * "Generate Next Round".
 *
 * Takes the teams that qualified from a stage, creates the following stage,
 * and draws its fixtures -- so the organizer never re-enters a team or
 * rebuilds a match table by hand.
 */
import { all, get, insert, run, tx } from '../db.js';
import { STAGE_LABELS } from '../config.js';
import { generateStageFixtures } from './scheduler.js';
import { recordAudit } from './audit.js';
import { notify } from './notify.js';
import { HttpError } from '../lib/http.js';

/** Which stage naturally follows, given how many teams came through. */
export function nextStageKind(formatType, qualifiedCount, currentKind) {
  if (formatType === 'single_elimination' || formatType === 'groups_knockout') {
    if (qualifiedCount <= 2) return 'grand_final';
    if (qualifiedCount <= 4) return 'semi_final';
    if (qualifiedCount <= 8) return 'quarter_final';
    if (qualifiedCount <= 16) return 'round_of_16';
    return 'round_of_32';
  }
  // Points formats run group stage -> playoffs -> grand final.
  if (currentKind === 'group_stage') return qualifiedCount <= 16 ? 'grand_final' : 'custom';
  if (currentKind === 'custom') return 'grand_final';
  return 'grand_final';
}

const defaultName = (kind, index) =>
  kind === 'custom' ? `Playoffs ${index}` : (STAGE_LABELS[kind] || `Stage ${index}`);

/**
 * Create the stage that follows `fromStage` and populate it.
 *
 * @param {object} args
 * @param {object} args.tournament
 * @param {object} args.settings
 * @param {object} args.fromStage
 * @param {object} [args.config]  { name, kind, num_groups, num_rounds,
 *                                  matches_per_round, teams_per_match, startDate }
 */
export function generateNextStage({ tournament, settings, fromStage, config = {}, actor }) {
  const qualified = all(
    `SELECT t.*, q.rank FROM qualifications q JOIN teams t ON t.id = q.team_id
      WHERE q.stage_id = ? AND q.status = 'qualified' ORDER BY q.rank`,
    [fromStage.id],
  );

  if (!qualified.length) {
    throw new HttpError(
      400,
      'No qualified teams yet. Lock qualification for this stage first, then generate the next round.',
    );
  }
  if (qualified.length < 2) {
    throw new HttpError(400, 'At least two teams must qualify to build another stage.');
  }

  const existing = all('SELECT * FROM stages WHERE tournament_id = ? ORDER BY order_index', [tournament.id]);
  const orderIndex = Math.max(...existing.map((s) => s.order_index), -1) + 1;
  const kind = config.kind || nextStageKind(tournament.format_type, qualified.length, fromStage.kind);
  const name = config.name || defaultName(kind, orderIndex + 1);

  const teamsPerMatch = Number(config.teams_per_match)
    || (tournament.format_type === 'single_elimination' ? 2 : Math.min(qualified.length, tournament.teams_per_match));
  const numGroups = Number(config.num_groups) || Math.max(1, Math.ceil(qualified.length / teamsPerMatch));
  const numRounds = Number(config.num_rounds) || 1;
  const matchesPerRound = Number(config.matches_per_round)
    || (tournament.format_type === 'single_elimination'
      ? Math.ceil(qualified.length / 2)
      : Math.max(1, numGroups * (kind === 'grand_final' ? 6 : 3)));

  const stageId = tx(() => {
    const id = insert(
      `INSERT INTO stages
         (tournament_id, name, kind, order_index, status, num_groups, num_rounds,
          matches_per_round, teams_per_match, qualification, source_stage_id)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      [
        tournament.id, name, kind, orderIndex,
        numGroups, numRounds, matchesPerRound, teamsPerMatch,
        config.qualification ? JSON.stringify(config.qualification) : null,
        fromStage.id,
      ],
    );
    // Teams that came through are active again in the new stage; the rest stay out.
    const ids = qualified.map((t) => t.id);
    run(
      `UPDATE teams SET status = 'active' WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    return id;
  });

  const stage = get('SELECT * FROM stages WHERE id = ?', [stageId]);
  const seeded = qualified.map((t, i) => ({ ...t, seed: i + 1 }));

  const result = generateStageFixtures({
    tournament,
    settings,
    stage,
    teams: seeded,
    overrides: {
      seeded: true,
      startDate: config.startDate || null,
      formatType: config.formatType || (tournament.format_type === 'groups_knockout' ? 'single_elimination' : tournament.format_type),
    },
    actor,
  });

  recordAudit({
    tournamentId: tournament.id,
    actor,
    action: 'stage.created',
    entity: 'stage',
    entityId: stageId,
    summary: `Advanced ${qualified.length} team(s) from ${fromStage.name} into ${name}.`,
    after: { teams: qualified.map((t) => t.name) },
  });

  notify({
    tournamentId: tournament.id,
    type: 'stage.changed',
    title: `${name} is live`,
    body: `${qualified.length} teams advanced from ${fromStage.name}.`,
    severity: 'success',
  });

  return { stage, teams: seeded, ...result };
}

/** Convenience for the dashboard: the stage currently being played. */
export function currentStage(tournamentId) {
  return get(
    `SELECT * FROM stages WHERE tournament_id = ?
      ORDER BY CASE status WHEN 'live' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, order_index DESC LIMIT 1`,
    [tournamentId],
  ) || get('SELECT * FROM stages WHERE tournament_id = ? ORDER BY order_index DESC LIMIT 1', [tournamentId]);
}

/**
 * Qualification.
 *
 * The cut is computed from live standings every time it is asked for, so the
 * organizer sees it move as results come in. "Locking" a stage additionally
 * writes a snapshot to `qualifications` and stamps team.status, which is what
 * the next stage is then built from.
 */
import { all, get, insert, run, tx, parseJson } from '../db.js';
import { DEFAULT_QUALIFICATION } from '../config.js';
import { computeStandings } from './leaderboard.js';
import { recordAudit } from './audit.js';
import { notify } from './notify.js';

export function normaliseQualification(raw) {
  const config = { ...DEFAULT_QUALIFICATION, ...(parseJson(raw, null) || {}) };
  return {
    mode: ['top_overall', 'top_per_group', 'custom', 'all'].includes(config.mode) ? config.mode : 'top_overall',
    count: Math.max(0, Number(config.count) || 0),
    perGroup: Math.max(0, Number(config.perGroup) || 0),
    customTeamIds: Array.isArray(config.customTeamIds) ? config.customTeamIds.map(Number).filter(Boolean) : [],
  };
}

/**
 * Work out who is through, without writing anything.
 *
 * @returns {{ config, qualified: object[], eliminated: object[], standings: object[], groups: object[] }}
 */
export function previewQualification({ tournamentId, stageId = null, qualification, tiebreakers }) {
  const config = normaliseQualification(qualification);
  const standings = computeStandings({ tournamentId, stageId, tiebreakers });

  const qualifiedIds = new Set();
  let groupTables = [];

  if (config.mode === 'all') {
    standings.forEach((s) => qualifiedIds.add(s.team_id));
  } else if (config.mode === 'custom') {
    config.customTeamIds.forEach((id) => qualifiedIds.add(id));
  } else if (config.mode === 'top_per_group') {
    const groups = all(
      `SELECT id, name, order_index FROM groups WHERE tournament_id = ?
        ${stageId ? 'AND (stage_id = ? OR stage_id IS NULL)' : ''} ORDER BY order_index, name`,
      stageId ? [tournamentId, stageId] : [tournamentId],
    );
    groupTables = groups.map((group) => {
      const table = computeStandings({ tournamentId, stageId, groupId: group.id, tiebreakers });
      table.slice(0, config.perGroup).forEach((s) => qualifiedIds.add(s.team_id));
      return { group, standings: table };
    });
  } else {
    standings.slice(0, config.count).forEach((s) => qualifiedIds.add(s.team_id));
  }

  const groupRankOf = new Map();
  for (const { standings: table } of groupTables) {
    table.forEach((s, i) => groupRankOf.set(s.team_id, i + 1));
  }

  const decorate = (s) => ({ ...s, group_rank: groupRankOf.get(s.team_id) ?? null });
  return {
    config,
    standings: standings.map(decorate),
    groups: groupTables,
    qualified: standings.filter((s) => qualifiedIds.has(s.team_id)).map(decorate),
    eliminated: standings.filter((s) => !qualifiedIds.has(s.team_id)).map(decorate),
  };
}

const describe = (config) => {
  if (config.mode === 'all') return 'every team advances';
  if (config.mode === 'custom') return `${config.customTeamIds.length} hand-picked team(s)`;
  if (config.mode === 'top_per_group') return `top ${config.perGroup} from each group`;
  return `top ${config.count} overall`;
};

/**
 * Freeze the current cut: snapshot it into `qualifications`, set team.status,
 * mark the stage completed and tell everyone.
 */
export function lockQualification({ tournamentId, stageId, qualification, tiebreakers, actor }) {
  const preview = previewQualification({ tournamentId, stageId, qualification, tiebreakers });

  tx(() => {
    run('DELETE FROM qualifications WHERE stage_id = ?', [stageId]);

    const write = (rows, status) => {
      for (const s of rows) {
        insert(
          `INSERT INTO qualifications (tournament_id, stage_id, team_id, status, rank, group_rank, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [tournamentId, stageId, s.team_id, status, s.rank, s.group_rank ?? null, describe(preview.config)],
        );
        run('UPDATE teams SET status = ? WHERE id = ?', [status, s.team_id]);
      }
    };
    write(preview.qualified, 'qualified');
    write(preview.eliminated, 'eliminated');

    run("UPDATE stages SET status = 'completed' WHERE id = ?", [stageId]);
  });

  const stage = get('SELECT name FROM stages WHERE id = ?', [stageId]);
  recordAudit({
    tournamentId,
    actor,
    action: 'qualification.locked',
    entity: 'stage',
    entityId: stageId,
    summary: `Locked qualification for ${stage?.name || 'stage'}: ${preview.qualified.length} qualified, ${preview.eliminated.length} eliminated (${describe(preview.config)}).`,
    after: { qualified: preview.qualified.map((s) => s.team_name) },
  });

  notify({
    tournamentId,
    type: 'team.qualified',
    title: `${preview.qualified.length} teams qualified from ${stage?.name || 'the stage'}`,
    body: preview.qualified.slice(0, 8).map((s) => s.team_name).join(', ')
      + (preview.qualified.length > 8 ? `, +${preview.qualified.length - 8} more` : ''),
    severity: 'success',
    payload: { stageId, teamIds: preview.qualified.map((s) => s.team_id) },
  });

  return preview;
}

/** The stored snapshot for a stage, if it has been locked. */
export function storedQualification(stageId) {
  return all(
    `SELECT q.*, t.name AS team_name, t.tag, t.logo_url
       FROM qualifications q JOIN teams t ON t.id = q.team_id
      WHERE q.stage_id = ? ORDER BY q.status DESC, q.rank`,
    [stageId],
  );
}

/**
 * Points calculation. Pure functions -- the organizer never does arithmetic.
 *
 * Total = placement points + kill points + bonus - penalty
 *
 * Placement and kill points are derived from the tournament's scoring table,
 * but either can be overridden per result for the cases every organizer hits
 * eventually (a replayed match, an agreed correction, a manual adjustment).
 */
import { DEFAULT_SCORING } from '../config.js';

export function normaliseScoring(scoring) {
  const merged = { ...DEFAULT_SCORING, ...(scoring || {}) };
  const table = {};
  for (const [place, points] of Object.entries(merged.placementPoints || {})) {
    const p = Number(place);
    if (Number.isFinite(p) && p > 0) table[p] = Number(points) || 0;
  }
  return {
    placementPoints: Object.keys(table).length ? table : { ...DEFAULT_SCORING.placementPoints },
    killPoints: Number(merged.killPoints) || 0,
    winBonus: Number(merged.winBonus) || 0,
    defaultPlacementPoints: Number(merged.defaultPlacementPoints) || 0,
  };
}

/** Points awarded for finishing in `placement`. */
export function placementPointsFor(placement, scoring) {
  const table = scoring.placementPoints;
  const place = Number(placement);
  if (!Number.isFinite(place) || place <= 0) return 0;
  if (table[place] !== undefined) return table[place];
  return scoring.defaultPlacementPoints;
}

const num = (value, fallback = 0) => {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Turn one raw result entry into a fully-costed row.
 *
 * @param {object} entry  { team_id, placement, kills, bonus_points, penalty_points,
 *                          placement_points?, kill_points? }  -- the two optional
 *                          fields override the computed values when present.
 * @param {object} rawScoring tournament scoring config
 */
export function computeResult(entry, rawScoring) {
  const scoring = normaliseScoring(rawScoring);
  const placement = entry.placement === '' || entry.placement === null || entry.placement === undefined
    ? null
    : Math.max(1, Math.round(num(entry.placement, 1)));
  const kills = Math.max(0, Math.round(num(entry.kills)));

  const autoPlacement = placement === null ? 0 : placementPointsFor(placement, scoring);
  const autoKill = kills * scoring.killPoints;

  const placementPoints = entry.placement_points === undefined || entry.placement_points === null || entry.placement_points === ''
    ? autoPlacement
    : num(entry.placement_points);
  const killPoints = entry.kill_points === undefined || entry.kill_points === null || entry.kill_points === ''
    ? autoKill
    : num(entry.kill_points);

  const isWin = placement === 1;
  const bonus = num(entry.bonus_points) + (isWin ? scoring.winBonus : 0);
  const penalty = num(entry.penalty_points);

  return {
    team_id: Number(entry.team_id),
    placement,
    kills,
    placement_points: round2(placementPoints),
    kill_points: round2(killPoints),
    bonus_points: round2(bonus),
    penalty_points: round2(penalty),
    total_points: round2(placementPoints + killPoints + bonus - penalty),
    is_win: isWin ? 1 : 0,
    notes: entry.notes ? String(entry.notes).slice(0, 500) : null,
  };
}

/** Avoid 0.30000000000000004 creeping into stored totals. */
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Validate a full match result submission.
 * Returns { rows, errors } -- rows are computed, errors are human-readable.
 */
export function computeMatchResults(entries, scoring, { participantIds = null } = {}) {
  const errors = [];
  const rows = [];
  const seenTeams = new Set();
  const seenPlacements = new Map();

  for (const entry of entries || []) {
    const teamId = Number(entry.team_id);
    if (!Number.isFinite(teamId)) { errors.push('A result row is missing its team.'); continue; }
    if (seenTeams.has(teamId)) { errors.push(`Team ${teamId} appears twice in this result.`); continue; }
    seenTeams.add(teamId);
    if (participantIds && !participantIds.has(teamId)) {
      errors.push(`Team ${teamId} is not playing in this match.`);
      continue;
    }
    const row = computeResult(entry, scoring);
    if (row.placement !== null) {
      seenPlacements.set(row.placement, (seenPlacements.get(row.placement) || 0) + 1);
    }
    rows.push(row);
  }

  for (const [place, count] of seenPlacements) {
    if (count > 1) errors.push(`Placement #${place} is assigned to ${count} teams.`);
  }
  return { rows, errors };
}

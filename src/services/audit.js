/** Change history: who changed what, when, and what it looked like before. */
import { all, insert, toJson } from '../db.js';

/**
 * @param {object} entry
 * @param {number} entry.tournamentId
 * @param {object} [entry.actor]  the signed-in user
 * @param {string} entry.action   dotted verb, e.g. 'result.updated'
 * @param {string} entry.summary  one line, written for a human reader
 */
export function recordAudit({ tournamentId, actor, action, entity, entityId, summary, before, after, ip }) {
  return insert(
    `INSERT INTO audit_logs
       (tournament_id, user_id, actor_name, action, entity, entity_id, summary, before_json, after_json, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tournamentId ?? null,
      actor?.id ?? null,
      actor?.name ?? 'System',
      action,
      entity ?? null,
      entityId ?? null,
      summary,
      before === undefined ? null : toJson(before),
      after === undefined ? null : toJson(after),
      ip ?? null,
    ],
  );
}

export function listAudit(tournamentId, { limit = 100, offset = 0, action = null } = {}) {
  const where = ['tournament_id = ?'];
  const params = [tournamentId];
  if (action) { where.push('action LIKE ?'); params.push(`${action}%`); }
  params.push(Math.min(500, limit), offset);
  return all(
    `SELECT id, user_id, actor_name, action, entity, entity_id, summary, before_json, after_json, created_at
       FROM audit_logs WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    params,
  );
}

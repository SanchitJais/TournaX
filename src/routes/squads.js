/** Persistent teams: creation, roster, invitations and the public team page. */
import { all, get, run } from '../db.js';
import { can, requireUser } from '../auth.js';
import { badRequest, forbidden, notFound, saveDataUrl } from '../lib/http.js';
import { rateLimit } from '../lib/ratelimit.js';
import {
  createSquad, invite, isCaptain, leaveSquad, members, removeMember, requireCaptain,
  setMemberRole, squadById, squadBySlug, squadHistory, squadStats, updateSquad,
} from '../services/squads.js';
import { recordAudit } from '../services/audit.js';

const createLimiter = rateLimit('squad-create', { limit: 5, windowMs: 60 * 60_000, message: 'You have created several teams recently. Try again later.' });
const inviteLimiter = rateLimit('squad-invite', { limit: 40, windowMs: 60 * 60_000 });

export default function register(router) {
  /** Browse / search teams. */
  router.get('/api/squads', (ctx) => {
    const search = String(ctx.query.search || '').trim();
    const where = [];
    const params = [];
    if (search) { where.push('(s.name LIKE ? OR s.tag LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    if (ctx.query.game) { where.push('s.game = ?'); params.push(ctx.query.game); }
    params.push(Math.min(100, Number(ctx.query.limit) || 40));

    return {
      squads: all(
        `SELECT s.*,
                (SELECT COUNT(*) FROM squad_members m WHERE m.squad_id = s.id AND m.status = 'active') AS member_count,
                (SELECT COUNT(*) FROM teams t WHERE t.squad_id = s.id) AS tournament_count
           FROM squads s
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY s.name LIMIT ?`,
        params,
      ),
    };
  });

  router.post('/api/squads', (ctx) => {
    const user = requireUser(ctx);
    createLimiter(ctx);
    if (!can(user, 'squad:create')) throw forbidden('Your role cannot create teams.');

    const squad = createSquad({
      name: ctx.body.name,
      tag: ctx.body.tag,
      logo_url: saveDataUrl(ctx.body.logo_url, 'squad'),
      game: ctx.body.game,
      region: ctx.body.region,
      bio: ctx.body.bio,
      team_code: ctx.body.team_code,
      ownerId: user.id,
    }, user);
    return { __status: 201, squad, members: members(squad.id) };
  });

  /** Public team profile: roster, cumulative stats, tournament history. */
  router.get('/api/squads/:slug', (ctx) => {
    const squad = squadBySlug(ctx.params.slug);
    if (!squad) throw notFound('Team not found');
    return {
      squad,
      members: members(squad.id),
      stats: squadStats(squad.id),
      history: squadHistory(squad.id),
      can_manage: Boolean(ctx.user && (ctx.user.role === 'super_admin' || isCaptain(squad.id, ctx.user.id))),
      is_member: Boolean(ctx.user && get(
        "SELECT 1 AS ok FROM squad_members WHERE squad_id = ? AND user_id = ? AND status = 'active'",
        [squad.id, ctx.user.id],
      )),
    };
  });

  router.patch('/api/squads/:id', (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    requireCaptain(id, user);
    const fields = { ...ctx.body };
    if (fields.logo_url) fields.logo_url = saveDataUrl(fields.logo_url, 'squad');
    return { squad: updateSquad(id, fields, user) };
  });

  router.get('/api/squads/:id/members', (ctx) => {
    const id = Number(ctx.params.id);
    if (!squadById(id)) throw notFound('Team not found');
    return { members: members(id, { includeInactive: ctx.query.all === '1' }) };
  });

  // ---------------------------------------------------------- invitations --
  router.get('/api/squads/:id/invites', (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    requireCaptain(id, user);
    return {
      invites: all(
        `SELECT i.*, u.name AS invited_name FROM squad_invites i
           LEFT JOIN users u ON u.id = i.invited_user_id
          WHERE i.squad_id = ? ORDER BY i.created_at DESC LIMIT 60`,
        [id],
      ),
    };
  });

  router.post('/api/squads/:id/invites', (ctx) => {
    const user = requireUser(ctx);
    inviteLimiter(ctx);
    const id = Number(ctx.params.id);
    requireCaptain(id, user);
    return {
      __status: 201,
      invite: invite({
        squadId: id,
        email: ctx.body.email,
        userId: ctx.body.user_id,
        role: ctx.body.role || 'player',
        message: ctx.body.message,
      }, user),
    };
  });

  router.delete('/api/squads/:id/invites/:inviteId', (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    requireCaptain(id, user);
    run(
      "UPDATE squad_invites SET status = 'cancelled', responded_at = datetime('now') WHERE id = ? AND squad_id = ? AND status = 'pending'",
      [Number(ctx.params.inviteId), id],
    );
    return { ok: true };
  });

  // -------------------------------------------------------------- roster --
  router.post('/api/squads/:id/leave', (ctx) => {
    const user = requireUser(ctx);
    return leaveSquad({ squadId: Number(ctx.params.id), user });
  });

  router.delete('/api/squads/:id/members/:userId', (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    requireCaptain(id, user);
    return removeMember({ squadId: id, memberUserId: ctx.params.userId, actor: user });
  });

  router.patch('/api/squads/:id/members/:userId', (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    requireCaptain(id, user);
    if (ctx.body.role === 'captain' && squadById(id)?.owner_id !== user.id && user.role !== 'super_admin') {
      throw forbidden('Only the current owner can hand over the captaincy.');
    }
    return setMemberRole({ squadId: id, memberUserId: ctx.params.userId, role: ctx.body.role, actor: user });
  });

  router.delete('/api/squads/:id', (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    const squad = squadById(id);
    if (!squad) throw notFound('Team not found');
    if (squad.owner_id !== user.id && user.role !== 'super_admin') {
      throw forbidden('Only the team owner can delete it.');
    }
    const entered = get('SELECT COUNT(*) AS n FROM teams WHERE squad_id = ?', [id]).n;
    if (entered && user.role !== 'super_admin') {
      throw badRequest(`This team has played in ${entered} tournament(s), so its history cannot be deleted.`);
    }
    run('DELETE FROM squads WHERE id = ?', [id]);
    recordAudit({ actor: user, action: 'squad.deleted', entity: 'squad', entityId: id, summary: `Deleted team "${squad.name}".` });
    return { ok: true };
  });
}

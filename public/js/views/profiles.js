/** Public team page (/team/:slug) and public player page (/player/:id). */
import { api } from '../lib/api.js';
import { delegate, esc, formData, html, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import {
  confirmAction, emptyState, formatDate, modal, points, rankPill, teamLogo,
  toast, toastError, withBusy,
} from '../lib/ui.js';
import { bindShare, shareBox } from '../lib/share.js';
import { platformFooter, platformNav } from './chrome.js';

export default {
  title: (data) => data?.squad?.name || data?.player?.ign || 'Profile',

  async load(ctx) {
    if (ctx.params.playerId) {
      const player = await api.get(`/api/players/${ctx.params.playerId}`);
      return { kind: 'player', ...player };
    }
    const squad = await api.get(`/api/squads/${ctx.params.slug}`);
    const invites = squad.can_manage
      ? await api.get(`/api/squads/${squad.squad.id}/invites`).catch(() => ({ invites: [] }))
      : { invites: [] };
    return { kind: 'team', ...squad, invites: invites.invites, manage: ctx.query.manage === '1' };
  },

  render(data, ctx) {
    return data.kind === 'player' ? playerMarkup(data, ctx) : teamMarkup(data, ctx);
  },

  mounted(data, ctx, root) {
    bindShare(root);
    if (data.kind !== 'team') return;
    const squadId = data.squad.id;
    const reload = () => ctx.navigate(`/team/${data.squad.slug}${data.manage ? '?manage=1' : ''}`, { replace: true });

    delegate(root, {
      invite: () => inviteDialog(squadId, ctx, reload),
      edit: () => editTeamDialog(data.squad, ctx),

      async 'remove-member'(el) {
        const ok = await confirmAction({
          title: 'Remove player',
          message: `Remove ${el.dataset.name} from ${data.squad.name}?`,
          confirmLabel: 'Remove player',
        });
        if (!ok) return;
        try {
          await api.delete(`/api/squads/${squadId}/members/${el.dataset.user}`);
          toast('Player removed.');
          reload();
        } catch (err) { toastError(err); }
      },

      async 'set-role'(el) {
        try {
          await api.patch(`/api/squads/${squadId}/members/${el.dataset.user}`, { role: el.dataset.role });
          toast(`Role updated to ${el.dataset.role}.`, { type: 'success' });
          reload();
        } catch (err) { toastError(err); }
      },

      async 'cancel-invite'(el) {
        try {
          await api.delete(`/api/squads/${squadId}/invites/${el.dataset.id}`);
          toast('Invitation cancelled.');
          reload();
        } catch (err) { toastError(err); }
      },
    });
  },
};

// ------------------------------------------------------------------- team --
function teamMarkup(data, ctx) {
  const { squad, members, stats, history, can_manage: canManage, invites, manage } = data;
  const pending = invites.filter((i) => i.status === 'pending');

  return html`
    <div class="pub">
      ${raw(platformNav(ctx, 'teams'))}
      <main class="pub-main">
        <div class="card mb-3">
          <div class="card-body">
            <div class="row wrap" style="gap:16px">
              ${raw(teamLogo(squad, 'lg'))}
              <div class="grow" style="min-width:220px">
                <div class="row gap-sm mb-1">
                  <span class="badge badge-info">${squad.game}</span>
                  ${squad.tag ? raw(`<span class="badge badge-neutral">${esc(squad.tag)}</span>`) : ''}
                  ${squad.region ? raw(`<span class="badge badge-neutral">${esc(squad.region)}</span>`) : ''}
                </div>
                <h1 class="hero-title" style="font-size:28px">${squad.name}</h1>
                ${squad.bio ? raw(`<p class="muted small mt-1" style="max-width:640px">${esc(squad.bio)}</p>`) : ''}
              </div>
              ${canManage ? raw(`
                <div class="row gap-sm" style="align-items:flex-start">
                  <button class="btn" data-act="edit">${icon('edit', 15)} Edit team</button>
                  <button class="btn btn-primary" data-act="invite">${icon('plus', 15)} Invite player</button>
                </div>`) : ''}
            </div>
          </div>
        </div>

        <div class="grid grid-stats mb-3">
          ${raw([
            ['Tournaments', stats.tournaments, 'entered'],
            ['Matches', stats.matches, `${stats.wins} win(s)`],
            ['Total points', points(stats.points), `${stats.avg_points} avg`],
            ['Total kills', stats.kills, `${stats.avg_kills} avg`],
            ['Best placement', stats.best_placement ? `#${stats.best_placement}` : '--', 'all time'],
          ].map(([label, value, meta]) => `
            <div class="stat">
              <div class="stat-label">${esc(label)}</div>
              <div class="stat-value">${esc(String(value))}</div>
              <div class="stat-meta">${esc(meta)}</div>
            </div>`).join(''))}
        </div>

        <div class="grid grid-2" style="grid-template-columns:minmax(0,1fr) minmax(0,1.2fr)">
          <div class="col" style="gap:16px">
            <div class="card">
              <div class="card-head">
                <h2>Roster</h2>
                <span class="small dim">${members.length} player(s)</span>
              </div>
              <div class="card-body">
                <div class="col" style="gap:9px">
                  ${raw(members.map((m) => memberRow(m, canManage, squad)).join(''))}
                </div>
              </div>
            </div>

            ${canManage && pending.length ? raw(`
              <div class="card">
                <div class="card-head"><h2>Pending invitations</h2><span class="badge badge-warning">${pending.length}</span></div>
                <div class="card-body">
                  <div class="col" style="gap:8px">
                    ${pending.map((i) => `
                      <div class="member-row">
                        <span class="player-avatar">${icon('bell', 14)}</span>
                        <div class="grow" style="min-width:0">
                          <div class="truncate small" style="font-weight:600">${esc(i.invited_name || i.invited_email)}</div>
                          <div class="tiny dim">Invited as ${esc(i.role)}</div>
                        </div>
                        <button class="btn btn-ghost btn-icon" data-act="cancel-invite" data-id="${i.id}"
                                title="Cancel invitation">${icon('close', 14)}</button>
                      </div>`).join('')}
                  </div>
                </div>
              </div>`) : ''}

            <div class="card">
              <div class="card-body">${raw(shareBox(`/team/${squad.slug}`, { label: 'Share this team' }))}</div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h2>Tournament history</h2></div>
            <div class="card-body ${history.length ? 'tight' : ''}">
              ${history.length ? raw(`
                <div class="table-wrap">
                  <table class="data compact">
                    <thead><tr><th>Tournament</th><th>Status</th><th class="num">Matches</th><th class="num">Points</th></tr></thead>
                    <tbody>
                      ${history.map((h) => `
                        <tr>
                          <td>
                            <a style="font-weight:600" href="/tournament/${esc(h.slug)}">${esc(h.name)}</a>
                            <div class="tiny dim">${esc(h.game)}${h.start_date ? ` · ${formatDate(h.start_date, { withYear: true })}` : ''}</div>
                          </td>
                          <td>${teamStatus(h.team_status)}</td>
                          <td class="num">${h.matches_played}</td>
                          <td class="num strong">${points(h.points)}</td>
                        </tr>`).join('')}
                    </tbody>
                  </table>
                </div>`)
              : raw(emptyState({
                icon: 'trophy', title: 'No tournaments yet',
                message: 'Register for a tournament and its results will appear here.',
                action: '<a class="btn btn-primary mt-2" href="/tournaments">Browse tournaments</a>',
              }))}
            </div>
          </div>
        </div>
      </main>
      ${raw(platformFooter(squad.name))}
    </div>`;
}

const teamStatus = (status) => {
  const map = {
    qualified: '<span class="badge badge-qualified">Qualified</span>',
    eliminated: '<span class="badge badge-eliminated">Eliminated</span>',
    active: '<span class="badge badge-active">Active</span>',
    withdrawn: '<span class="badge badge-cancelled">Withdrawn</span>',
  };
  return map[status] || `<span class="badge badge-neutral">${esc(status || '--')}</span>`;
};

function memberRow(m, canManage, squad) {
  const isOwner = squad.owner_id === m.user_id;
  return `
    <div class="member-row">
      ${m.profile_avatar || m.avatar_url
        ? `<span class="player-avatar"><img src="${esc(m.profile_avatar || m.avatar_url)}" alt="" style="width:100%;height:100%;object-fit:cover"></span>`
        : `<span class="player-avatar">${esc((m.ign || m.name || '?').slice(0, 2).toUpperCase())}</span>`}
      <div class="grow" style="min-width:0">
        <a class="truncate" style="font-weight:600;display:block" href="/player/${m.user_id}">${esc(m.ign || m.name)}</a>
        <div class="tiny dim truncate">
          ${esc(m.name)}${m.in_game_id ? ` · ${esc(m.in_game_id)}` : ''}${m.country ? ` · ${esc(m.country)}` : ''}
        </div>
      </div>
      <span class="role-pill ${esc(m.role)}">${esc(m.role)}</span>
      ${canManage && !isOwner ? `
        <div class="row gap-sm">
          ${m.role !== 'substitute'
            ? `<button class="btn btn-ghost btn-sm" data-act="set-role" data-user="${m.user_id}" data-role="substitute" title="Make substitute">Sub</button>`
            : `<button class="btn btn-ghost btn-sm" data-act="set-role" data-user="${m.user_id}" data-role="player" title="Make starter">Start</button>`}
          <button class="btn btn-ghost btn-icon" data-act="remove-member" data-user="${m.user_id}"
                  data-name="${esc(m.ign || m.name)}" title="Remove from team">${icon('trash', 13)}</button>
        </div>` : ''}
    </div>`;
}

// ----------------------------------------------------------------- player --
function playerMarkup(data, ctx) {
  const { player, career, squads } = data;
  const socials = player.socials || {};

  return html`
    <div class="pub">
      ${raw(platformNav(ctx, null))}
      <main class="pub-main" style="max-width:1050px">
        <div class="card mb-3">
          <div class="card-body">
            <div class="row wrap" style="gap:16px">
              ${player.avatar_url
                ? raw(`<span class="player-avatar lg"><img src="${esc(player.avatar_url)}" alt="" style="width:100%;height:100%;object-fit:cover"></span>`)
                : raw(`<span class="player-avatar lg">${esc((player.ign || player.name || '?').slice(0, 2).toUpperCase())}</span>`)}
              <div class="grow" style="min-width:220px">
                <h1 class="hero-title" style="font-size:28px">${player.ign || player.name}</h1>
                <div class="row wrap small muted mt-1" style="gap:12px">
                  <span>${player.name}</span>
                  ${player.country ? raw(`<span>${esc(player.country)}${player.region ? `, ${esc(player.region)}` : ''}</span>`) : ''}
                  ${player.game ? raw(`<span class="badge badge-info">${esc(player.game)}</span>`) : ''}
                  ${player.in_game_id ? raw(`<span class="mono tiny dim">ID ${esc(player.in_game_id)}</span>`) : ''}
                </div>
                ${player.bio ? raw(`<p class="muted small mt-2" style="max-width:620px">${esc(player.bio)}</p>`) : ''}
                <div class="row wrap gap-sm mt-2">
                  ${raw(Object.entries(socials).filter(([, v]) => v).map(([key, url]) => `
                    <a class="chip" href="${esc(url)}" target="_blank" rel="noopener nofollow">${esc(key)}</a>`).join(''))}
                  ${player.discord ? raw(`<span class="chip">Discord: ${esc(player.discord)}</span>`) : ''}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="grid grid-stats mb-3">
          ${raw([
            ['Tournaments', career.tournaments, 'appearances'],
            ['Matches', career.matches, `${career.wins} win(s)`],
            ['Team points', points(career.team_points), `${career.avg_points} avg`],
            career.has_individual_stats
              ? ['Kills', career.kills, `${career.avg_kills} per match`]
              : ['Kills', '--', 'not recorded yet'],
            ['Best placement', career.best_placement ? `#${career.best_placement}` : '--', 'all time'],
          ].map(([label, value, meta]) => `
            <div class="stat">
              <div class="stat-label">${esc(label)}</div>
              <div class="stat-value">${esc(String(value))}</div>
              <div class="stat-meta">${esc(meta)}</div>
            </div>`).join(''))}
        </div>

        ${!career.has_individual_stats ? raw(`
          <div class="info-box mb-3">${icon('info', 15)}
            <div>Individual kill counts appear once organizers record per-player stats.
            Points and wins come from this player's team results.</div>
          </div>`) : ''}

        <div class="grid grid-2">
          <div class="card">
            <div class="card-head"><h2>Teams</h2></div>
            <div class="card-body ${squads.length ? '' : 'tight'}">
              ${squads.length ? raw(`
                <div class="col" style="gap:9px">
                  ${squads.map((s) => `
                    <div class="member-row">
                      ${teamLogo(s, 'sm')}
                      <a class="grow truncate" style="font-weight:600" href="/team/${esc(s.slug)}">${esc(s.name)}</a>
                      <span class="role-pill ${esc(s.role)}">${esc(s.role)}</span>
                    </div>`).join('')}
                </div>`)
              : raw(emptyState({ icon: 'teams', title: 'Not in a team' }))}
            </div>
          </div>
          <div class="card">
            <div class="card-body">${raw(shareBox(`/player/${player.id}`, { label: 'Share this player' }))}</div>
          </div>
        </div>
      </main>
      ${raw(platformFooter())}
    </div>`;
}

// ---------------------------------------------------------------- dialogs --
function inviteDialog(squadId, ctx, reload) {
  modal({
    title: 'Invite a player',
    size: 'narrow',
    body: html`
      <p class="muted small">
        They will see the invitation the next time they sign in. If they do not have an account yet,
        the invite waits for them to join with that email address.
      </p>
      <form id="invite-form" class="col mt-2" style="gap:13px">
        <div class="field">
          <label class="label required" for="i-email">Player email<span class="req">★</span></label>
          <input class="input" id="i-email" name="email" type="email" required placeholder="player@example.com">
        </div>
        <div class="field">
          <label class="label" for="i-role">Role</label>
          <select class="select" id="i-role" name="role">
            <option value="player">Player</option>
            <option value="substitute">Substitute</option>
            <option value="captain">Co-captain</option>
          </select>
        </div>
        <div class="field">
          <label class="label" for="i-msg">Message</label>
          <textarea class="textarea" id="i-msg" name="message" rows="2" placeholder="Optional note"></textarea>
        </div>
      </form>`,
    footer: `
      <button class="btn" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="do-invite" data-busy-label="Sending">Send invitation</button>`,
    onMount(overlay, close) {
      overlay.querySelector('#do-invite').addEventListener('click', async (e) => {
        const values = formData(overlay.querySelector('#invite-form'));
        if (!values.email) { toast('Enter an email address.', { type: 'error' }); return; }
        await withBusy(e.currentTarget, async () => {
          await api.post(`/api/squads/${squadId}/invites`, values);
          toast('Invitation sent.', { type: 'success' });
          close();
          reload();
        });
      });
    },
  });
}

function editTeamDialog(squad, ctx) {
  modal({
    title: `Edit ${squad.name}`,
    size: 'narrow',
    body: html`
      <form id="edit-team" class="col" style="gap:13px">
        <div class="field">
          <label class="label" for="e-name">Team name</label>
          <input class="input" id="e-name" name="name" value="${squad.name}">
        </div>
        <div class="grid grid-2" style="gap:12px">
          <div class="field">
            <label class="label" for="e-tag">Tag</label>
            <input class="input" id="e-tag" name="tag" value="${squad.tag || ''}" maxlength="8">
          </div>
          <div class="field">
            <label class="label" for="e-region">Region</label>
            <input class="input" id="e-region" name="region" value="${squad.region || ''}">
          </div>
        </div>
        <div class="field">
          <label class="label" for="e-bio">About</label>
          <textarea class="textarea" id="e-bio" name="bio" rows="3">${squad.bio || ''}</textarea>
        </div>
      </form>`,
    footer: `
      <button class="btn" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="do-edit" data-busy-label="Saving">Save</button>`,
    onMount(overlay, close) {
      overlay.querySelector('#do-edit').addEventListener('click', async (e) => {
        const values = formData(overlay.querySelector('#edit-team'));
        await withBusy(e.currentTarget, async () => {
          const res = await api.patch(`/api/squads/${squad.id}`, values);
          toast('Team updated.', { type: 'success' });
          close();
          ctx.navigate(`/team/${res.squad.slug}?manage=1`, { replace: true });
        });
      });
    },
  });
}

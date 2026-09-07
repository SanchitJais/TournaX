/** Organizer console: registrations, approvals, check-in and penalties. */
import { api } from '../lib/api.js';
import { $, delegate, esc, formData, html, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import {
  confirmAction, emptyState, formatDateTime, modal, relativeTime, teamLogo,
  toast, toastError, withBusy,
} from '../lib/ui.js';
import { can } from '../main.js';

export default {
  title: 'Registrations',

  async load(ctx) {
    const id = Number(ctx.params.id);
    const tab = ctx.query.tab || 'registrations';
    const [registrations, penalties, teams] = await Promise.all([
      api.get(`/api/tournaments/${id}/registrations`),
      api.get(`/api/tournaments/${id}/penalties`),
      api.get(`/api/tournaments/${id}/teams`),
    ]);
    return { tournamentId: id, tab, ...registrations, penalties: penalties.penalties, kinds: penalties.kinds, teams: teams.teams };
  },

  render(data) {
    const { tab, counts, state, check_in: checkIn, tournamentId } = data;

    return html`
      <div class="page">
        <div class="page-head">
          <div class="page-title">
            <h1>Registrations &amp; discipline</h1>
            <p class="muted small" style="margin:0">
              Approve entries, run check-in, and apply penalties. Every action is logged.
            </p>
          </div>
          <div class="row wrap">
            <button class="btn ${state.open ? 'btn-danger' : 'btn-primary'}" data-act="toggle-registration">
              ${raw(icon(state.open ? 'lock' : 'zap', 15))}
              ${state.open ? 'Close registration' : 'Open registration'}
            </button>
          </div>
        </div>

        <div class="grid grid-stats mb-3">
          ${raw([
            ['Registered', counts.total, `${counts.approved} approved`],
            ['Awaiting approval', counts.pending, counts.pending ? 'Needs your decision' : 'All clear'],
            ['Rejected', counts.rejected, `${counts.withdrawn} withdrew`],
            ['Checked in', data.registrations.filter((r) => r.checked_in_at).length, `${data.no_shows.length} not yet`],
          ].map(([label, value, meta], i) => `
            <div class="stat ${i === 1 && counts.pending ? 'warn' : ''}">
              <div class="stat-label">${esc(label)}</div>
              <div class="stat-value">${esc(String(value))}</div>
              <div class="stat-meta">${esc(meta)}</div>
            </div>`).join(''))}
        </div>

        <div class="tabs mb-3">
          ${raw([
            ['registrations', `Registrations${counts.pending ? ` (${counts.pending})` : ''}`],
            ['checkin', 'Check-in'],
            ['penalties', `Penalties${data.penalties.length ? ` (${data.penalties.length})` : ''}`],
          ].map(([key, label]) => `
            <a class="tab ${tab === key ? 'active' : ''}"
               href="/admin/t/${tournamentId}/registrations?tab=${key}">${esc(label)}</a>`).join(''))}
        </div>

        ${raw({
          registrations: () => registrationsTab(data),
          checkin: () => checkinTab(data),
          penalties: () => penaltiesTab(data),
        }[tab]?.() || registrationsTab(data))}
      </div>`;
  },

  mounted(data, ctx, root) {
    const reload = (tab = data.tab) =>
      ctx.navigate(`/admin/t/${data.tournamentId}/registrations?tab=${tab}`, { replace: true });

    delegate(root, {
      async 'toggle-registration'(el) {
        await withBusy(el, async () => {
          const res = await api.post(`/api/tournaments/${data.tournamentId}/registration/toggle`, { open: !data.state.open });
          toast(res.state.open ? 'Registration is open.' : 'Registration is closed.', { type: 'success' });
          reload();
        });
      },

      async approve(el) {
        try {
          await api.post(`/api/tournaments/${data.tournamentId}/registrations/${el.dataset.id}/decision`, { approve: true });
          toast(`${el.dataset.name} approved.`, { type: 'success' });
          reload();
        } catch (err) { toastError(err); }
      },

      reject: (el) => rejectDialog(data, ctx, el.dataset.id, el.dataset.name, reload),

      async 'approve-all'(el) {
        const ok = await confirmAction({
          title: 'Approve every pending team',
          message: `Approve all ${data.counts.pending} pending registration(s)?`,
          detail: 'Each team is added to the tournament with its roster.',
          confirmLabel: 'Approve all',
          danger: false,
        });
        if (!ok) return;
        await withBusy(el, async () => {
          const res = await api.post(`/api/tournaments/${data.tournamentId}/registrations/bulk`, { approve: true });
          toast(`${res.processed} team(s) approved.`, { type: 'success' });
          res.errors?.forEach((message) => toast(message, { type: 'error', timeout: 7000 }));
          reload();
        });
      },

      roster: (el) => {
        const registration = data.registrations.find((r) => r.id === Number(el.dataset.id));
        modal({
          title: `${registration.team_name} — roster`,
          size: 'narrow',
          body: `
            <div class="col" style="gap:8px">
              ${registration.roster.map((p) => `
                <div class="member-row">
                  <span class="player-avatar">${esc((p.ign || p.name || '?').slice(0, 2).toUpperCase())}</span>
                  <div class="grow" style="min-width:0">
                    <div class="truncate" style="font-weight:600">${esc(p.ign || p.name)}</div>
                    <div class="tiny dim">${esc(p.name)}${p.in_game_id ? ` · ${esc(p.in_game_id)}` : ''}</div>
                  </div>
                  <span class="role-pill ${esc(p.role)}">${esc(p.role)}</span>
                </div>`).join('')}
            </div>
            <dl class="kv mt-3">
              <dt>Submitted by</dt><dd>${esc(registration.submitted_by_name || '--')}</dd>
              <dt>Contact</dt><dd>${esc(registration.contact_email || '--')}${registration.contact_phone ? ` · ${esc(registration.contact_phone)}` : ''}</dd>
              <dt>Submitted</dt><dd>${esc(registration.created_at)}</dd>
            </dl>`,
          footer: '<button class="btn btn-primary" data-modal-close>Close</button>',
        });
      },

      async 'force-checkin'(el) {
        try {
          await api.post(`/api/tournaments/${data.tournamentId}/check-in`, {
            registration_id: Number(el.dataset.id), force: true,
          });
          toast(`${el.dataset.name} checked in.`, { type: 'success' });
          reload('checkin');
        } catch (err) { toastError(err); }
      },

      async 'close-checkin'(el) {
        const ok = await confirmAction({
          title: 'Remove no-shows',
          message: `Remove ${data.no_shows.length} team(s) that never checked in?`,
          detail: 'Their registrations are withdrawn and they are taken out of the tournament.',
          confirmLabel: 'Remove no-shows',
        });
        if (!ok) return;
        await withBusy(el, async () => {
          const res = await api.post(`/api/tournaments/${data.tournamentId}/check-in/close`, { withdraw: true });
          toast(`${res.removed} no-show team(s) removed.`, { type: 'success' });
          reload('checkin');
        });
      },

      'add-penalty': () => penaltyDialog(data, ctx, reload),

      async 'revoke-penalty'(el) {
        const ok = await confirmAction({
          title: 'Revoke penalty',
          message: 'Revoke this penalty?',
          detail: 'The standings recalculate immediately, and the revocation is logged.',
          confirmLabel: 'Revoke',
          danger: false,
        });
        if (!ok) return;
        try {
          await api.delete(`/api/tournaments/${data.tournamentId}/penalties/${el.dataset.id}`);
          toast('Penalty revoked. Standings updated.', { type: 'success' });
          reload('penalties');
        } catch (err) { toastError(err); }
      },
    });
  },
};

// ------------------------------------------------------------------- tabs --
function registrationsTab(data) {
  const { registrations, counts, state } = data;
  if (!registrations.length) {
    return emptyState({
      icon: 'teams',
      title: 'No registrations yet',
      message: state.open
        ? 'Share the registration link and teams will appear here as they sign up.'
        : 'Open registration so teams can sign up.',
    });
  }

  const pending = registrations.filter((r) => r.status === 'pending');
  const decided = registrations.filter((r) => r.status !== 'pending');

  return `
    ${pending.length ? `
      <div class="card mb-3">
        <div class="card-head">
          <h2>Awaiting approval</h2>
          <button class="btn btn-primary btn-sm" data-act="approve-all" data-busy-label="Approving">
            ${icon('check', 14)} Approve all ${counts.pending}
          </button>
        </div>
        <div class="card-body">
          <div class="col" style="gap:10px">${pending.map((r) => approvalRow(r, true)).join('')}</div>
        </div>
      </div>` : ''}

    <div class="card">
      <div class="card-head"><h2>All registrations</h2><span class="small dim">${registrations.length}</span></div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>Team</th><th>Captain</th><th class="num">Players</th><th>Status</th><th>Checked in</th><th>Submitted</th><th></th></tr></thead>
            <tbody>
              ${registrations.map((r) => `
                <tr>
                  <td>${teamLogo({ name: r.team_name, logo_url: r.logo_url }, 'sm')}
                      <span style="font-weight:600;margin-left:8px">${esc(r.team_name)}</span></td>
                  <td class="small muted">${esc(r.submitted_by_name || '--')}</td>
                  <td class="num">${r.roster.length}</td>
                  <td>${regBadge(r.status)}</td>
                  <td class="small">${r.checked_in_at ? '<span class="badge badge-completed">Yes</span>' : '<span class="dim">--</span>'}</td>
                  <td class="small dim nowrap">${relativeTime(r.created_at, { assumeUtc: true })}</td>
                  <td>
                    <div class="row gap-sm">
                      <button class="btn btn-ghost btn-sm" data-act="roster" data-id="${r.id}">Roster</button>
                      ${r.status === 'pending' ? `
                        <button class="btn btn-sm btn-success" data-act="approve" data-id="${r.id}" data-name="${esc(r.team_name)}">Approve</button>
                        <button class="btn btn-sm btn-danger" data-act="reject" data-id="${r.id}" data-name="${esc(r.team_name)}">Reject</button>` : ''}
                      ${r.status === 'approved' ? `
                        <button class="btn btn-ghost btn-sm" data-act="reject" data-id="${r.id}" data-name="${esc(r.team_name)}">Remove</button>` : ''}
                    </div>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

const regBadge = (status) => ({
  pending: '<span class="badge badge-warning">Pending</span>',
  approved: '<span class="badge badge-qualified">Approved</span>',
  rejected: '<span class="badge badge-eliminated">Rejected</span>',
  withdrawn: '<span class="badge badge-cancelled">Withdrawn</span>',
}[status] || `<span class="badge badge-neutral">${esc(status)}</span>`);

function approvalRow(r) {
  return `
    <div class="approval-row pending">
      ${teamLogo({ name: r.team_name, logo_url: r.logo_url }, 'lg')}
      <div class="grow" style="min-width:0">
        <div style="font-weight:650">${esc(r.team_name)}</div>
        <div class="small muted">
          Captain: ${esc(r.submitted_by_name || '--')} · ${r.roster.length} players
          ${r.contact_email ? ` · ${esc(r.contact_email)}` : ''}
        </div>
        <div class="tiny dim mt-1">Submitted ${relativeTime(r.created_at, { assumeUtc: true })}</div>
      </div>
      <div class="row gap-sm">
        <button class="btn btn-sm" data-act="roster" data-id="${r.id}">View roster</button>
        <button class="btn btn-sm btn-danger" data-act="reject" data-id="${r.id}" data-name="${esc(r.team_name)}">Reject</button>
        <button class="btn btn-sm btn-success" data-act="approve" data-id="${r.id}" data-name="${esc(r.team_name)}">Approve</button>
      </div>
    </div>`;
}

function checkinTab(data) {
  const { check_in: window, registrations, no_shows: noShows } = data;
  const approved = registrations.filter((r) => r.status === 'approved');

  return `
    <div class="card mb-3">
      <div class="card-head"><h2>Check-in window</h2>
        ${window.enabled
          ? (window.open ? '<span class="badge badge-live"><span class="dot"></span>Open</span>' : '<span class="badge badge-neutral">Closed</span>')
          : '<span class="badge badge-neutral">Disabled</span>'}
      </div>
      <div class="card-body">
        ${window.enabled ? `
          <dl class="kv">
            <dt>Opens</dt><dd>${window.opens_at ? formatDateTime(window.opens_at) : '--'}</dd>
            <dt>Closes</dt><dd>${window.closes_at ? formatDateTime(window.closes_at) : '--'}</dd>
            <dt>First match</dt><dd>${window.first_match ? formatDateTime(window.first_match) : 'Not scheduled'}</dd>
          </dl>
          ${window.reason ? `<div class="info-box mt-2">${icon('info', 15)}<div>${esc(window.reason)}</div></div>` : ''}
        ` : `
          <p class="small muted" style="margin:0">
            Check-in is switched off for this tournament. Turn it on in
            <a href="/admin/t/${data.tournamentId}/settings?tab=registration" style="color:var(--primary-2)">Settings → Registration</a>
            to make teams confirm they are ready before the first match.
          </p>`}
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Teams</h2>
        ${noShows.length ? `<button class="btn btn-danger btn-sm" data-act="close-checkin">
          ${icon('alert', 14)} Remove ${noShows.length} no-show(s)</button>` : ''}
      </div>
      <div class="card-body tight">
        ${approved.length ? `
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Team</th><th>Status</th><th>Checked in at</th><th></th></tr></thead>
              <tbody>
                ${approved.map((r) => `
                  <tr class="${r.checked_in_at ? 'is-qualified' : ''}">
                    <td>${teamLogo({ name: r.team_name, logo_url: r.logo_url }, 'sm')}
                        <span style="font-weight:600;margin-left:8px">${esc(r.team_name)}</span></td>
                    <td>${r.checked_in_at
                      ? '<span class="badge badge-completed">Ready</span>'
                      : '<span class="badge badge-warning">Not checked in</span>'}</td>
                    <td class="small dim">${r.checked_in_at ? relativeTime(r.checked_in_at, { assumeUtc: true }) : '--'}</td>
                    <td>${r.checked_in_at ? '' : `
                      <button class="btn btn-sm" data-act="force-checkin" data-id="${r.id}" data-name="${esc(r.team_name)}">
                        Check in for them</button>`}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>`
        : emptyState({ icon: 'teams', title: 'No approved teams yet' })}
      </div>
    </div>`;
}

function penaltiesTab(data) {
  const { penalties, kinds } = data;
  return `
    <div class="card">
      <div class="card-head">
        <h2>Penalties &amp; disqualifications</h2>
        ${can('penalties:write') ? `<button class="btn btn-primary btn-sm" data-act="add-penalty">
          ${icon('alert', 14)} Apply penalty</button>` : ''}
      </div>
      <div class="card-body ${penalties.length ? 'tight' : ''}">
        ${penalties.length ? `
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Type</th><th>Team</th><th class="num">Points</th><th>Reason</th><th>Applied by</th><th>When</th><th></th></tr></thead>
              <tbody>
                ${penalties.map((p) => `
                  <tr>
                    <td><span class="badge badge-${p.kind === 'disqualification' ? 'eliminated' : 'warning'}">
                      ${esc(kinds[p.kind] || p.kind)}</span></td>
                    <td>${p.team_name ? esc(p.team_name) : '<span class="dim">Tournament-wide</span>'}</td>
                    <td class="num" style="color:var(--danger)">${p.points ? `-${p.points}` : '--'}</td>
                    <td class="small muted">${esc(p.reason)}</td>
                    <td class="small">${esc(p.created_by_name || 'System')}</td>
                    <td class="small dim nowrap">${relativeTime(p.created_at, { assumeUtc: true })}</td>
                    <td>${can('penalties:write')
                      ? `<button class="btn btn-ghost btn-sm" data-act="revoke-penalty" data-id="${p.id}">Revoke</button>` : ''}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>`
        : emptyState({
          icon: 'check', title: 'No penalties applied',
          message: 'Point deductions, disqualifications and suspensions appear here, and are reflected in the standings straight away.',
        })}
      </div>
    </div>`;
}

// ---------------------------------------------------------------- dialogs --
function rejectDialog(data, ctx, id, name, reload) {
  modal({
    title: `Reject ${name}`,
    size: 'narrow',
    body: `
      <p class="muted small">The captain is notified. If the team was already approved, it is removed from the tournament.</p>
      <div class="field mt-2">
        <label class="label" for="reject-reason">Reason (shown to the team)</label>
        <textarea class="textarea" id="reject-reason" rows="3" placeholder="Incomplete roster, duplicate entry, ..."></textarea>
      </div>`,
    footer: `
      <button class="btn" data-modal-close>Cancel</button>
      <button class="btn btn-danger" id="do-reject" data-busy-label="Rejecting">Reject registration</button>`,
    onMount(overlay, close) {
      overlay.querySelector('#do-reject').addEventListener('click', async (e) => {
        const reason = overlay.querySelector('#reject-reason').value.trim();
        await withBusy(e.currentTarget, async () => {
          await api.post(`/api/tournaments/${data.tournamentId}/registrations/${id}/decision`, { approve: false, reason });
          toast(`${name} rejected.`);
          close();
          reload();
        });
      });
    },
  });
}

function penaltyDialog(data, ctx, reload) {
  modal({
    title: 'Apply a penalty',
    body: html`
      <form id="penalty-form" class="col" style="gap:14px">
        <div class="grid grid-2" style="gap:14px">
          <div class="field">
            <label class="label" for="pen-kind">Type</label>
            <select class="select" id="pen-kind" name="kind">
              ${raw(Object.entries(data.kinds).map(([value, label]) =>
                `<option value="${value}">${esc(label)}</option>`).join(''))}
            </select>
          </div>
          <div class="field" id="points-field">
            <label class="label" for="pen-points">Points to deduct</label>
            <input class="input" id="pen-points" name="points" type="number" min="0" step="0.5" value="5">
          </div>
          <div class="field" style="grid-column:1/-1">
            <label class="label" for="pen-team">Team</label>
            <select class="select" id="pen-team" name="team_id">
              <option value="">Tournament-wide (no specific team)</option>
              ${raw(data.teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join(''))}
            </select>
          </div>
          <div class="field" style="grid-column:1/-1">
            <label class="label required" for="pen-reason">Reason<span class="req">★</span></label>
            <textarea class="textarea" id="pen-reason" name="reason" rows="2" required
              placeholder="Late start, roster breach, misconduct..."></textarea>
            <span class="hint">Stored in the audit trail and shown to the team.</span>
          </div>
        </div>
        <div class="warn-box">
          ${raw(icon('alert', 15))}
          <div>Point deductions come straight off the leaderboard. A disqualification also marks the team eliminated. Both can be revoked.</div>
        </div>
      </form>`,
    footer: `
      <button class="btn" data-modal-close>Cancel</button>
      <button class="btn btn-danger" id="do-penalty" data-busy-label="Applying">Apply penalty</button>`,
    onMount(overlay, close) {
      const kind = overlay.querySelector('#pen-kind');
      const toggle = () => {
        overlay.querySelector('#points-field').classList.toggle('hidden', kind.value !== 'points');
      };
      kind.addEventListener('change', toggle);
      toggle();

      overlay.querySelector('#do-penalty').addEventListener('click', async (e) => {
        const values = formData(overlay.querySelector('#penalty-form'));
        if (!values.reason?.trim()) { toast('A reason is required.', { type: 'error' }); return; }
        await withBusy(e.currentTarget, async () => {
          await api.post(`/api/tournaments/${data.tournamentId}/penalties`, values);
          toast('Penalty applied. Standings updated.', { type: 'success' });
          close();
          reload('penalties');
        });
      });
    },
  });
}

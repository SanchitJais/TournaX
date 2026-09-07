/** Match Center: every match, its status, room details and result state. */
import { api, download, qs } from '../lib/api.js';
import { $, debounce, delegate, esc, html, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import {
  emptyState, formatDate, formatTime, modal, statusBadge, toast, toastError, withBusy,
} from '../lib/ui.js';
import { can } from '../main.js';

let filters = { status: '', stage: '', search: '' };

export default {
  title: 'Match Center',

  async load(ctx) {
    filters = { status: ctx.query.status || '', stage: ctx.query.stage || '', search: ctx.query.search || '' };
    const id = Number(ctx.params.id);
    const [matches, bundle] = await Promise.all([
      api.get(`/api/tournaments/${id}/matches${qs(filters)}`),
      api.get(`/api/tournaments/${id}`),
    ]);
    return { tournamentId: id, matches: matches.matches, stages: bundle.stages };
  },

  render(data) {
    const { matches, stages, tournamentId } = data;
    const counts = matches.reduce((acc, m) => { acc[m.status] = (acc[m.status] || 0) + 1; return acc; }, {});

    return html`
      <div class="page">
        <div class="page-head">
          <div class="page-title">
            <h1>Match Center</h1>
            <p class="muted small" style="margin:0">
              ${matches.length} match(es)
              ${counts.live ? raw(` · <span style="color:var(--danger)">${counts.live} live</span>`) : ''}
              ${counts.completed ? ` · ${counts.completed} completed` : ''}
            </p>
          </div>
          <div class="row wrap">
            ${can('matches:write') ? raw(`<button class="btn" data-act="credentials">${icon('key', 15)} Room details</button>`) : ''}
            <button class="btn" data-act="export">${raw(icon('download', 15))} Schedule</button>
          </div>
        </div>

        <div class="card">
          <div class="card-head" style="gap:10px;flex-wrap:wrap">
            <div class="row gap-sm wrap">
              ${raw(['', 'upcoming', 'live', 'completed', 'cancelled'].map((s) => `
                <button class="chip ${filters.status === s ? 'active' : ''}" data-act="filter-status" data-value="${s}">
                  ${s ? esc(s[0].toUpperCase() + s.slice(1)) : 'All'}
                  ${s && counts[s] ? `<span class="tiny dim">${counts[s]}</span>` : ''}
                </button>`).join(''))}
            </div>
            <div class="grow"></div>
            <div class="row gap-sm wrap">
              <select class="select input-sm" id="filter-stage" style="width:auto">
                <option value="">All stages</option>
                ${raw(stages.map((s) => `<option value="${s.id}" ${String(filters.stage) === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join(''))}
              </select>
              <div class="search" style="flex:0 1 220px">
                ${raw(icon('search'))}
                <input class="input input-sm" id="match-search" placeholder="Search matches" value="${filters.search}">
              </div>
            </div>
          </div>

          <div class="card-body tight">
            ${matches.length ? raw(table(matches, tournamentId)) : raw(emptyState({
              icon: 'calendar',
              title: filters.status || filters.search ? 'No matches match those filters' : 'No matches yet',
              message: filters.status || filters.search
                ? 'Clear the filters to see everything.'
                : 'Generate fixtures and the whole schedule appears here.',
              action: `<a class="btn btn-primary mt-2" href="/admin/t/${tournamentId}/fixtures">${icon('zap', 15)} Generate fixtures</a>`,
            }))}
          </div>
        </div>
      </div>`;
  },

  mounted(data, ctx, root) {
    const reload = () => ctx.navigate(`/admin/t/${data.tournamentId}/matches${qs(filters)}`, { replace: true });

    const search = $('#match-search', root);
    search?.addEventListener('input', debounce((e) => { filters.search = e.target.value.trim(); reload(); }, 280));
    if (filters.search && search) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
    $('#filter-stage', root)?.addEventListener('change', (e) => { filters.stage = e.target.value; reload(); });

    delegate(root, {
      'filter-status': (el) => { filters.status = el.dataset.value; reload(); },
      export: () => download(`/api/tournaments/${data.tournamentId}/export/schedule.pdf`),
      credentials: () => credentialsDialog(data, ctx),
      open: (el) => ctx.navigate(`/admin/t/${data.tournamentId}/matches/${el.dataset.id}`),

      async status(el) {
        const { id, value } = el.dataset;
        try {
          await api.patch(`/api/matches/${id}`, { status: value });
          toast(`Match marked ${value}.`, { type: 'success' });
          reload();
        } catch (err) { toastError(err); }
      },
    });
  },
};

function table(matches, tournamentId) {
  return `
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width:86px">Match</th><th>Round</th><th>Group</th><th>Teams</th>
            <th>Date</th><th>Time</th><th>Room</th><th>Status</th><th style="width:120px"></th>
          </tr>
        </thead>
        <tbody>
          ${matches.map((m) => `
            <tr class="${m.status === 'live' ? 'is-qualified' : ''}">
              <td>
                <a class="strong" href="/admin/t/${tournamentId}/matches/${m.id}">Match ${m.match_no}</a>
                ${m.map ? `<div class="tiny dim">${esc(m.map)}</div>` : ''}
              </td>
              <td class="small muted">${esc(m.round_name || '--')}</td>
              <td>${m.group_name ? `<span class="badge badge-neutral">${esc(m.group_name)}</span>` : '<span class="dim">--</span>'}</td>
              <td class="small muted truncate" style="max-width:280px" title="${esc(m.teams.map((t) => t.name).join(', '))}">
                ${m.teams.length ? `${m.teams.length} teams` : '<span class="dim">None</span>'}
                ${m.winner ? `<span class="badge badge-completed" style="margin-left:6px">${icon('crown', 11)} winner set</span>` : ''}
              </td>
              <td class="small nowrap">${formatDate(m.scheduled_at)}</td>
              <td class="small nowrap">${formatTime(m.scheduled_at)}</td>
              <td class="small">${roomCell(m)}</td>
              <td>${statusBadge(m.status)}</td>
              <td>
                <div class="row gap-sm">
                  ${m.status === 'upcoming' ? `<button class="btn btn-sm" data-act="status" data-id="${m.id}" data-value="live" title="Start match">${icon('play', 13)}</button>` : ''}
                  ${m.status === 'live' ? `<button class="btn btn-sm btn-success" data-act="open" data-id="${m.id}">Score</button>` : ''}
                  ${m.status === 'completed' ? `<button class="btn btn-sm" data-act="open" data-id="${m.id}">${icon('edit', 13)}</button>` : ''}
                  ${m.status === 'upcoming' ? `<button class="btn btn-sm" data-act="open" data-id="${m.id}">${icon('edit', 13)}</button>` : ''}
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function roomCell(m) {
  if (m.room_id) {
    return `<span class="credentials tiny">${esc(m.room_id)} / ${esc(m.room_password || '--')}</span>`;
  }
  if (m.credentials?.reveal_at) {
    return `<span class="locked tiny">${icon('lock', 12)} reveals ${formatTime(m.credentials.reveal_at)}</span>`;
  }
  return '<span class="dim">--</span>';
}

/** Bulk-publish room IDs and passwords, optionally on a timer. */
function credentialsDialog(data, ctx) {
  const pending = data.matches.filter((m) => m.status !== 'completed' && m.status !== 'cancelled');

  modal({
    title: 'Room IDs and passwords',
    size: 'wide',
    body: html`
      <p class="muted small">
        Fill in the room details for upcoming matches. Set a reveal time and they stay hidden
        from the public page until then.
      </p>
      ${pending.length ? raw(`
        <div class="table-wrap mt-2" style="max-height:420px;overflow-y:auto">
          <table class="data compact">
            <thead><tr><th>Match</th><th>Time</th><th style="width:140px">Room ID</th>
              <th style="width:140px">Password</th><th style="width:200px">Reveal at</th></tr></thead>
            <tbody>
              ${pending.map((m) => `
                <tr data-cred-row data-id="${m.id}">
                  <td class="strong nowrap">Match ${m.match_no}</td>
                  <td class="small dim nowrap">${formatDate(m.scheduled_at)} ${formatTime(m.scheduled_at)}</td>
                  <td><input class="input input-sm mono" data-field="room_id" value="${esc(m.room_id || '')}" placeholder="1234567"></td>
                  <td><input class="input input-sm mono" data-field="room_password" value="${esc(m.room_password || '')}" placeholder="secret"></td>
                  <td><input class="input input-sm" type="datetime-local" data-field="credentials_reveal_at"
                             value="${esc((m.credentials_reveal_at || '').replace(' ', 'T').slice(0, 16))}"></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`) : raw(emptyState({ icon: 'check', title: 'Nothing pending', message: 'Every match is already completed or cancelled.' }))}`,
    footer: pending.length ? `
      <button class="btn" id="reveal-now">Reveal all now</button>
      <div class="grow"></div>
      <button class="btn" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="save-creds" data-busy-label="Publishing">Publish details</button>` : '',
    onMount(overlay, close) {
      overlay.querySelector('#reveal-now')?.addEventListener('click', () => {
        overlay.querySelectorAll('[data-field=credentials_reveal_at]').forEach((input) => { input.value = ''; });
        toast('Reveal times cleared -- details will show as soon as you publish.');
      });

      overlay.querySelector('#save-creds')?.addEventListener('click', async (e) => {
        const entries = [...overlay.querySelectorAll('[data-cred-row]')].map((row) => ({
          match_id: Number(row.dataset.id),
          room_id: row.querySelector('[data-field=room_id]').value.trim() || null,
          room_password: row.querySelector('[data-field=room_password]').value.trim() || null,
          credentials_reveal_at: row.querySelector('[data-field=credentials_reveal_at]').value || null,
        }));
        await withBusy(e.currentTarget, async () => {
          const res = await api.post(`/api/tournaments/${data.tournamentId}/matches/credentials`, { entries });
          toast(`Room details published for ${res.updated} match(es).`, { type: 'success' });
          close();
          ctx.navigate(`/admin/t/${data.tournamentId}/matches${qs(filters)}`, { replace: true });
        });
      });
    },
  });
}

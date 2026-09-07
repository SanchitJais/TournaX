/** Team management: add, edit, bulk import, group assignment, search. */
import { api, download, qs } from '../lib/api.js';
import { $, debounce, delegate, esc, formData, html, raw, readFileAsBase64, readImage } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import {
  confirmAction, emptyState, modal, teamCell, teamLogo, teamStatusBadge, toast, toastError, withBusy,
} from '../lib/ui.js';
import { can } from '../main.js';

let filters = { search: '', group: '', status: '' };

export default {
  title: 'Teams',

  async load(ctx) {
    filters = { search: ctx.query.search || '', group: ctx.query.group || '', status: ctx.query.status || '' };
    const data = await api.get(`/api/tournaments/${ctx.params.id}/teams${qs(filters)}`);
    return { ...data, tournamentId: Number(ctx.params.id) };
  },

  render(data) {
    const { teams, groups } = data;
    const editable = can('teams:write');

    return html`
      <div class="page">
        <div class="page-head">
          <div class="page-title">
            <h1>Teams</h1>
            <p class="muted small" style="margin:0">
              ${teams.length} registered${groups.length ? ` across ${groups.length} group(s)` : ''}.
              Enter each team once -- fixtures, rankings and later rounds all reuse it.
            </p>
          </div>
          ${editable ? raw(`
            <div class="row wrap">
              <button class="btn" data-act="import">${icon('upload', 15)} Import</button>
              <button class="btn" data-act="groups">${icon('layers', 15)} Assign groups</button>
              <button class="btn btn-primary" data-act="add">${icon('plus', 15)} Add team</button>
            </div>`) : ''}
        </div>

        <div class="card">
          <div class="card-head" style="gap:10px;flex-wrap:wrap">
            <div class="search">
              ${raw(icon('search'))}
              <input class="input" id="team-search" placeholder="Search team, tag, ID or captain" value="${filters.search}">
            </div>
            <div class="row wrap gap-sm">
              <select class="select input-sm" id="filter-group" style="width:auto">
                <option value="">All groups</option>
                ${raw(groups.map((g) => `<option value="${g.id}" ${String(filters.group) === String(g.id) ? 'selected' : ''}>${esc(g.name)}</option>`).join(''))}
              </select>
              <select class="select input-sm" id="filter-status" style="width:auto">
                ${raw(['', 'active', 'qualified', 'eliminated', 'withdrawn'].map((s) =>
                  `<option value="${s}" ${filters.status === s ? 'selected' : ''}>${s ? esc(s[0].toUpperCase() + s.slice(1)) : 'All statuses'}</option>`).join(''))}
              </select>
              <button class="btn btn-sm" data-act="export">${raw(icon('download', 14))} Export</button>
            </div>
          </div>

          <div class="card-body tight">
            ${teams.length ? raw(tableMarkup(teams, editable)) : raw(emptyState({
              icon: 'teams',
              title: filters.search || filters.group || filters.status ? 'No teams match those filters' : 'No teams yet',
              message: filters.search
                ? 'Try a different search.'
                : 'Add teams one by one, or import your whole list from an Excel or CSV sheet.',
              action: editable ? `
                <div class="row mt-2">
                  <button class="btn btn-primary" data-act="add">${icon('plus', 15)} Add team</button>
                  <button class="btn" data-act="import">${icon('upload', 15)} Import sheet</button>
                </div>` : '',
            }))}
          </div>
        </div>
      </div>`;
  },

  mounted(data, ctx, root) {
    const reload = () => ctx.navigate(`/admin/t/${data.tournamentId}/teams${qs(filters)}`, { replace: true });

    const searchBox = $('#team-search', root);
    searchBox?.addEventListener('input', debounce((e) => {
      filters.search = e.target.value.trim();
      reload();
    }, 280));
    // Keep the caret where it was after the re-render.
    if (filters.search && searchBox) {
      searchBox.focus();
      searchBox.setSelectionRange(searchBox.value.length, searchBox.value.length);
    }

    $('#filter-group', root)?.addEventListener('change', (e) => { filters.group = e.target.value; reload(); });
    $('#filter-status', root)?.addEventListener('change', (e) => { filters.status = e.target.value; reload(); });

    delegate(root, {
      add: () => teamForm({ data, ctx }),
      edit: (el) => teamForm({ data, ctx, team: data.teams.find((t) => t.id === Number(el.dataset.id)) }),
      import: () => importDialog({ data, ctx }),
      groups: () => groupDialog({ data, ctx }),
      export: () => download(`/api/tournaments/${data.tournamentId}/export/teams.xlsx`),

      async delete(el) {
        const team = data.teams.find((t) => t.id === Number(el.dataset.id));
        const ok = await confirmAction({
          title: 'Remove team',
          message: `Remove "${team.name}" from this tournament?`,
          detail: 'Any results already recorded for this team are deleted with it, and the leaderboard recalculates.',
          confirmLabel: 'Remove team',
        });
        if (!ok) return;
        try {
          const res = await api.delete(`/api/teams/${team.id}`);
          toast(res.removed_results
            ? `${team.name} removed, along with ${res.removed_results} result row(s).`
            : `${team.name} removed.`, { type: 'success' });
          reload();
        } catch (err) { toastError(err); }
      },
    });
  },
};

// ------------------------------------------------------------------- table --
function tableMarkup(teams, editable) {
  return `
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width:52px">Seed</th>
            <th>Team</th>
            <th>Team ID</th>
            <th>Captain</th>
            <th>Group</th>
            <th>Players</th>
            <th>Status</th>
            ${editable ? '<th style="width:84px"></th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${teams.map((t) => `
            <tr>
              <td class="num dim">${t.seed ?? '--'}</td>
              <td>${teamCell(t)}</td>
              <td class="mono tiny dim">${esc(t.team_code || '--')}</td>
              <td>${esc(t.captain_name || '--')}</td>
              <td>${t.group_name ? `<span class="badge badge-neutral">${esc(t.group_name)}</span>` : '<span class="dim">--</span>'}</td>
              <td class="small muted truncate" style="max-width:230px" title="${esc(t.players.map((p) => p.name).join(', '))}">
                ${t.players.length ? esc(t.players.map((p) => p.name).join(', ')) : '<span class="dim">No roster</span>'}
              </td>
              <td>${teamStatusBadge(t.status)}</td>
              ${editable ? `
                <td>
                  <div class="row gap-sm">
                    <button class="btn btn-ghost btn-icon" data-act="edit" data-id="${t.id}" title="Edit">${icon('edit', 14)}</button>
                    <button class="btn btn-ghost btn-icon" data-act="delete" data-id="${t.id}" title="Remove">${icon('trash', 14)}</button>
                  </div>
                </td>` : ''}
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ------------------------------------------------------------- team dialog --
function teamForm({ data, ctx, team = null }) {
  const isEdit = Boolean(team);
  const players = team?.players?.length ? team.players : [{ name: '', in_game_id: '' }];
  let logoData = team?.logo_url || null;

  modal({
    title: isEdit ? `Edit ${team.name}` : 'Add team',
    body: html`
      <form id="team-form" class="col" style="gap:14px">
        <div class="row" style="gap:14px;align-items:flex-end">
          <label style="cursor:pointer" title="Upload team logo">
            ${raw(teamLogo(team || {}, 'lg'))}
            <input type="file" accept="image/*" id="logo-input" hidden>
          </label>
          <div class="field grow">
            <label class="label" for="t-name">Team name *</label>
            <input class="input" id="t-name" name="name" value="${team?.name || ''}" required autocomplete="off">
          </div>
          <div class="field" style="width:110px">
            <label class="label" for="t-tag">Tag</label>
            <input class="input" id="t-tag" name="tag" value="${team?.tag || ''}" placeholder="SOUL" maxlength="10">
          </div>
        </div>

        <div class="grid grid-2">
          <div class="field">
            <label class="label" for="t-code">Team ID</label>
            <input class="input" id="t-code" name="team_code" value="${team?.team_code || ''}" placeholder="T-001">
          </div>
          <div class="field">
            <label class="label" for="t-seed">Seed</label>
            <input class="input" id="t-seed" name="seed" type="number" min="1" value="${team?.seed ?? ''}">
          </div>
          <div class="field">
            <label class="label" for="t-captain">Captain name</label>
            <input class="input" id="t-captain" name="captain_name" value="${team?.captain_name || ''}">
          </div>
          <div class="field">
            <label class="label" for="t-contact">Captain contact</label>
            <input class="input" id="t-contact" name="captain_contact" value="${team?.captain_contact || ''}"
                   placeholder="Email or phone">
            <span class="hint">Never shown on the public page.</span>
          </div>
          <div class="field">
            <label class="label" for="t-group">Group</label>
            <select class="select" id="t-group" name="group_id">
              <option value="">Unassigned</option>
              ${raw(data.groups.map((g) => `<option value="${g.id}" ${team?.group_id === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join(''))}
            </select>
          </div>
          <div class="field">
            <label class="label" for="t-status">Status</label>
            <select class="select" id="t-status" name="status">
              ${raw(['active', 'qualified', 'eliminated', 'withdrawn'].map((s) =>
                `<option value="${s}" ${team?.status === s ? 'selected' : ''}>${esc(s[0].toUpperCase() + s.slice(1))}</option>`).join(''))}
            </select>
          </div>
        </div>

        <div>
          <div class="row-between mb-1">
            <span class="label">Players</span>
            <button type="button" class="btn btn-sm" id="add-player">${raw(icon('plus', 13))} Add player</button>
          </div>
          <div class="col" id="players" style="gap:8px">
            ${raw(players.map(playerRow).join(''))}
          </div>
        </div>
      </form>`,
    footer: `
      <button class="btn" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="save-team" data-busy-label="Saving">${isEdit ? 'Save changes' : 'Add team'}</button>`,
    onMount(overlay, close) {
      const form = overlay.querySelector('#team-form');
      const playersHost = overlay.querySelector('#players');

      overlay.querySelector('#add-player').addEventListener('click', () => {
        playersHost.insertAdjacentHTML('beforeend', playerRow({ name: '', in_game_id: '' }));
      });
      playersHost.addEventListener('click', (e) => {
        if (e.target.closest('[data-remove-player]')) {
          e.preventDefault();
          e.target.closest('.row').remove();
        }
      });

      overlay.querySelector('#logo-input').addEventListener('change', async (e) => {
        try {
          logoData = await readImage(e.target);
          const holder = e.target.closest('label').querySelector('.team-logo');
          if (holder && logoData) holder.innerHTML = `<img src="${logoData}" alt="" style="width:100%;height:100%;object-fit:cover">`;
        } catch (err) { toastError(err); }
      });

      overlay.querySelector('#save-team').addEventListener('click', async (e) => {
        const values = formData(form);
        if (!values.name?.trim()) { toast('A team needs a name.', { type: 'error' }); return; }

        const roster = [...playersHost.querySelectorAll('[data-player-row]')].map((row, i) => ({
          name: row.querySelector('[name=player_name]').value.trim(),
          in_game_id: row.querySelector('[name=player_ign]').value.trim() || null,
          is_captain: i === 0,
        })).filter((p) => p.name);

        const payload = {
          ...values,
          seed: values.seed || null,
          group_id: values.group_id || null,
          logo_url: logoData && logoData.startsWith('data:') ? logoData : undefined,
          players: roster,
        };

        await withBusy(e.currentTarget, async () => {
          if (isEdit) await api.patch(`/api/teams/${team.id}`, payload);
          else await api.post(`/api/tournaments/${data.tournamentId}/teams`, payload);
          toast(isEdit ? 'Team updated.' : `${payload.name} added.`, { type: 'success' });
          close();
          ctx.navigate(`/admin/t/${data.tournamentId}/teams${qs(filters)}`, { replace: true });
        });
      });
    },
  });
}

const playerRow = (player) => `
  <div class="row gap-sm" data-player-row>
    <input class="input input-sm grow" name="player_name" placeholder="Player name" value="${esc(player.name || '')}">
    <input class="input input-sm" name="player_ign" style="width:150px" placeholder="In-game ID" value="${esc(player.in_game_id || '')}">
    <button type="button" class="btn btn-ghost btn-icon" data-remove-player title="Remove">${icon('close', 14)}</button>
  </div>`;

// ----------------------------------------------------------- import dialog --
function importDialog({ data, ctx }) {
  let picked = null;

  modal({
    title: 'Import teams',
    size: 'wide',
    body: html`
      <div class="info-box mb-2">
        ${raw(icon('info', 15))}
        <div>
          Upload an <b>.xlsx</b> or <b>.csv</b> sheet. Column names are matched flexibly, so
          "Team Name", "team", "Squad Name" and "Clan" all work.
        </div>
      </div>

      <div class="grid grid-2" style="gap:16px">
        <div>
          <label class="label">1. Choose a file</label>
          <label class="lobby" style="cursor:pointer;display:block;text-align:center;padding:22px">
            ${raw(icon('upload', 22))}
            <div class="mt-1" id="file-label">Click to select a spreadsheet</div>
            <div class="tiny dim">.xlsx or .csv</div>
            <input type="file" id="import-file" accept=".xlsx,.csv,text/csv" hidden>
          </label>

          <div class="divider"></div>
          <label class="label">Or paste CSV directly</label>
          <textarea class="textarea mono" id="csv-text" rows="6"
            placeholder="Team Name,Captain,Group&#10;Soul Esports,Mortal,A"></textarea>
        </div>

        <div>
          <label class="label">Expected columns</label>
          <div class="lobby" style="font-size:12px">
            <div class="col" style="gap:5px">
              ${raw([
                ['Team Name', 'required'], ['Tag', 'optional'], ['Team ID', 'optional'],
                ['Captain Name', 'optional'], ['Captain Contact', 'optional'],
                ['Group', 'creates groups automatically'], ['Seed', 'optional'],
                ['Player 1 ... Player 5', 'optional'], ['Player 1 IGN ...', 'optional'],
              ].map(([col, note]) => `
                <div class="row-between"><span class="mono">${esc(col)}</span><span class="tiny dim">${esc(note)}</span></div>
              `).join(''))}
            </div>
          </div>
          <button class="btn btn-sm btn-block mt-2" id="dl-template">${raw(icon('download', 14))} Download a blank template</button>

          <div class="divider"></div>
          <label class="label">2. How should existing teams be handled?</label>
          <label class="check mt-1"><input type="radio" name="mode" value="merge" checked style="appearance:auto">
            <span>Merge -- update teams that already exist, add the rest</span></label>
          <label class="check mt-1"><input type="radio" name="mode" value="replace" style="appearance:auto">
            <span>Replace -- delete every current team first</span></label>
        </div>
      </div>`,
    footer: `
      <button class="btn" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="run-import" data-busy-label="Importing">Import teams</button>`,
    onMount(overlay, close) {
      const fileInput = overlay.querySelector('#import-file');
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        overlay.querySelector('#file-label').textContent = file.name;
        picked = await readFileAsBase64(file);
      });

      overlay.querySelector('#dl-template').addEventListener('click', async () => {
        const { headers, example } = await api.get('/api/import-template');
        const csv = `${headers.join(',')}\n${example.map((c) => (String(c).includes(',') ? `"${c}"` : c)).join(',')}\n`;
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'team-import-template.csv';
        a.click();
        URL.revokeObjectURL(url);
      });

      overlay.querySelector('#run-import').addEventListener('click', async (e) => {
        const csv = overlay.querySelector('#csv-text').value.trim();
        const mode = overlay.querySelector('input[name=mode]:checked').value;
        if (!picked && !csv) { toast('Choose a file or paste some CSV first.', { type: 'error' }); return; }

        if (mode === 'replace') {
          const ok = await confirmAction({
            title: 'Replace all teams',
            message: 'Every current team will be deleted before importing.',
            detail: 'Fixtures and results attached to those teams go with them.',
            confirmLabel: 'Replace everything',
          });
          if (!ok) return;
        }

        await withBusy(e.currentTarget, async () => {
          const report = await api.post(`/api/tournaments/${data.tournamentId}/teams/import`,
            picked ? { file: picked, mode } : { csv, mode });
          close();
          showReport(report);
          ctx.navigate(`/admin/t/${data.tournamentId}/teams`, { replace: true });
        });
      });
    },
  });
}

function showReport(report) {
  const lines = [
    report.created ? `${report.created} team(s) added` : null,
    report.updated ? `${report.updated} updated` : null,
    report.groups ? `${report.groups} group(s) created` : null,
  ].filter(Boolean).join(', ');

  toast(lines || 'Nothing to import.', { type: report.created || report.updated ? 'success' : 'info', title: 'Import complete' });

  if (report.skipped?.length) {
    modal({
      title: `${report.skipped.length} row(s) skipped`,
      size: 'narrow',
      body: `<div class="col" style="gap:6px">
        ${report.skipped.slice(0, 40).map((s) => `
          <div class="row-between small"><span class="dim">Row ${s.row}</span><span>${esc(s.reason)}</span></div>`).join('')}
      </div>`,
      footer: '<button class="btn btn-primary" data-modal-close>Got it</button>',
    });
  }
}

// ------------------------------------------------------------ group dialog --
function groupDialog({ data, ctx }) {
  modal({
    title: 'Assign teams to groups',
    size: 'narrow',
    body: html`
      <p class="muted small">
        Teams are spread evenly using a snake draw, so no group ends up stacked with the strongest seeds.
      </p>
      <div class="field mt-2">
        <label class="label" for="g-count">Number of groups</label>
        <input class="input" id="g-count" type="number" min="1" max="32" value="${Math.max(1, data.groups.length || 2)}">
      </div>
      <label class="check mt-2">
        <input type="checkbox" id="g-seeded" checked>
        Use team seeds (uncheck for a random draw)
      </label>
      <div class="warn-box mt-2">
        ${raw(icon('alert', 15))}
        <div>This replaces the current group assignment. Generate fixtures afterwards to rebuild the schedule.</div>
      </div>`,
    footer: `
      <button class="btn" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="do-groups" data-busy-label="Assigning">Assign groups</button>`,
    onMount(overlay, close) {
      overlay.querySelector('#do-groups').addEventListener('click', async (e) => {
        await withBusy(e.currentTarget, async () => {
          const res = await api.post(`/api/tournaments/${data.tournamentId}/teams/assign-groups`, {
            num_groups: Number(overlay.querySelector('#g-count').value) || 1,
            seeded: overlay.querySelector('#g-seeded').checked,
          });
          toast(`Teams spread across ${res.groups.length} group(s).`, { type: 'success' });
          close();
          ctx.navigate(`/admin/t/${data.tournamentId}/teams`, { replace: true });
        });
      });
    },
  });
}

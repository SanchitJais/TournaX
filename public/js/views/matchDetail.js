/**
 * Single match: details, room credentials, and the result-entry grid.
 * Points recalculate as you type; the organizer never adds anything up.
 */
import { api } from '../lib/api.js';
import { $, $$, delegate, esc, formData, html, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import {
  confirmAction, formatDate, formatTime, points, statusBadge, teamCell, toast, toastError, withBusy,
} from '../lib/ui.js';
import { can } from '../main.js';

export default {
  title: (data) => data?.match?.label || 'Match',

  async load(ctx) {
    const [res, playerStats] = await Promise.all([
      api.get(`/api/matches/${ctx.params.matchId}/results`),
      api.get(`/api/matches/${ctx.params.matchId}/player-stats`).catch(() => ({ teams: [] })),
    ]);
    return { ...res, playerStats, tournamentId: Number(ctx.params.id) };
  },

  render(data) {
    const { match, scoring, tournamentId } = data;
    const canScore = can('results:write');
    const canEdit = can('matches:write');

    return html`
      <div class="page">
        <div class="page-head">
          <div class="page-title">
            <div class="row small muted gap-sm">
              <a href="/admin/t/${tournamentId}/matches">Match Center</a>
              <span class="dim">/</span>
              <span>${match.stage_name}</span>
            </div>
            <h1>${match.label || `Match ${match.match_no}`} ${raw(statusBadge(match.status))}</h1>
            <p class="muted small" style="margin:0">
              ${match.round_name ? `${esc(match.round_name)} · ` : ''}
              ${match.group_name ? `${esc(match.group_name)} · ` : ''}
              ${formatDate(match.scheduled_at)} at ${formatTime(match.scheduled_at)}
              ${match.map ? ` · ${esc(match.map)}` : ''}
            </p>
          </div>
          <div class="row wrap">
            ${raw(statusButtons(match, canScore || canEdit))}
          </div>
        </div>

        <div class="grid grid-2" style="grid-template-columns:minmax(0,1fr) minmax(0,320px)">
          <div class="col" style="gap:16px">
            ${raw(resultCard(data, canScore))}
            ${raw(playerStatsCard(data, canScore))}
          </div>
          <div class="col" style="gap:16px">
            ${raw(detailsCard(match, canEdit))}
            ${raw(lineupCard(match))}
          </div>
        </div>
      </div>`;
  },

  mounted(data, ctx, root) {
    const { match, scoring } = data;
    const recalc = () => recalculateAll(root, scoring);

    // Recompute on any edit to placement / kills / bonus / penalty.
    root.addEventListener('input', (e) => {
      if (e.target.closest('[data-result-row]')) recalc();
    });
    recalc();

    delegate(root, {
      async status(el) {
        try {
          await api.patch(`/api/matches/${match.id}`, { status: el.dataset.value });
          toast(`Match marked ${el.dataset.value}.`, { type: 'success' });
          ctx.navigate(`/admin/t/${data.tournamentId}/matches/${match.id}`, { replace: true });
        } catch (err) { toastError(err); }
      },

      'fill-placements': () => {
        // Number the rows in their current visual order.
        $$('[data-result-row]', root).forEach((row, i) => {
          row.querySelector('[data-field=placement]').value = i + 1;
        });
        recalc();
        toast('Placements numbered in the current order.');
      },

      'sort-rows': () => {
        const body = $('#result-rows', root);
        const rows = $$('[data-result-row]', root).sort((a, b) => {
          const pa = Number(a.querySelector('[data-field=placement]').value) || 999;
          const pb = Number(b.querySelector('[data-field=placement]').value) || 999;
          return pa - pb;
        });
        rows.forEach((row) => body.appendChild(row));
        recalc();
      },

      async save(el) {
        const entries = collectEntries(root);
        const missing = entries.filter((e) => e.placement === null).length;
        if (missing && missing !== entries.length) {
          const ok = await confirmAction({
            title: 'Some placements are blank',
            message: `${missing} team(s) have no placement. Save anyway?`,
            detail: 'Teams without a placement score kill points only.',
            confirmLabel: 'Save anyway',
            danger: false,
          });
          if (!ok) return;
        }
        await withBusy(el, async () => {
          await api.put(`/api/matches/${match.id}/results`, { entries, status: el.dataset.status || 'completed' });
          toast('Results saved. Leaderboard updated.', { type: 'success', title: 'Done' });
          ctx.navigate(`/admin/t/${data.tournamentId}/matches/${match.id}`, { replace: true });
        });
      },

      async clear(el) {
        const ok = await confirmAction({
          title: 'Clear results',
          message: 'Remove every recorded result for this match?',
          detail: 'The match returns to "upcoming" and the leaderboard recalculates without it.',
          confirmLabel: 'Clear results',
        });
        if (!ok) return;
        try {
          await api.delete(`/api/matches/${match.id}/results`);
          toast('Results cleared.', { type: 'success' });
          ctx.navigate(`/admin/t/${data.tournamentId}/matches/${match.id}`, { replace: true });
        } catch (err) { toastError(err); }
      },

      'toggle-pstats': (el) => {
        const panel = $('#pstats-body', root);
        if (!panel) return;
        panel.hidden = !panel.hidden;
        el.textContent = panel.hidden ? 'Record per-player kills' : 'Hide';
      },

      async 'save-pstats'(el) {
        const entries = $('[data-pstat-row]', root).map((row) => ({
          player_id: Number(row.dataset.player),
          kills: Number(row.querySelector('[data-pfield=kills]').value) || 0,
          damage: Number(row.querySelector('[data-pfield=damage]').value) || 0,
        }));
        await withBusy(el, async () => {
          const res = await api.put(`/api/matches/${match.id}/player-stats`, { entries });
          toast(`Saved stats for ${res.written} player(s). Kill and MVP boards updated.`, { type: 'success' });
          ctx.navigate(`/admin/t/${data.tournamentId}/matches/${match.id}`, { replace: true });
        });
      },

      async 'save-details'(el) {
        const values = formData($('#match-details', root));
        await withBusy(el, async () => {
          await api.patch(`/api/matches/${match.id}`, values);
          toast('Match details saved.', { type: 'success' });
          ctx.navigate(`/admin/t/${data.tournamentId}/matches/${match.id}`, { replace: true });
        });
      },
    });
  },
};

// ------------------------------------------------------------------ pieces --
function statusButtons(match, allowed) {
  if (!allowed) return '';
  const options = [
    ['upcoming', 'Upcoming', ''],
    ['live', 'Go live', 'btn-danger'],
    ['completed', 'Completed', 'btn-success'],
    ['cancelled', 'Cancel', ''],
  ];
  return `<div class="btn-group">
    ${options.map(([value, label]) => `
      <button class="btn ${match.status === value ? 'active' : ''}" data-act="status" data-value="${value}">${esc(label)}</button>
    `).join('')}
  </div>`;
}

function resultCard(data, canScore) {
  const { match, scoring } = data;
  const rows = buildRows(match);

  if (!rows.length) {
    return `
      <div class="card"><div class="card-body">
        <div class="empty">
          <div class="empty-ico">${icon('alert', 22)}</div>
          <h3>No teams in this match</h3>
          <p class="muted small">Generate fixtures, or add teams to this match, before entering results.</p>
        </div>
      </div></div>`;
  }

  const placementTable = Object.entries(scoring.placementPoints || {})
    .map(([place, pts]) => `#${place}=${pts}`).slice(0, 8).join('  ');

  return `
    <div class="card">
      <div class="card-head">
        <h2>Result entry</h2>
        <div class="row gap-sm">
          ${canScore ? `
            <button class="btn btn-sm" data-act="sort-rows" title="Reorder rows by placement">${icon('refresh', 13)} Sort</button>
            <button class="btn btn-sm" data-act="fill-placements">Number 1-${rows.length}</button>` : ''}
        </div>
      </div>
      <div class="card-body">
        <div class="info-box mb-2">
          ${icon('zap', 15)}
          <div>
            <b>Total = placement + kills + bonus - penalty.</b>
            ${scoring.killPoints} point(s) per kill. ${placementTable ? `Placement: ${esc(placementTable)}` : ''}
          </div>
        </div>

        <div class="table-wrap">
          <div style="min-width:720px">
            <div class="result-row result-head mb-1">
              <span>#</span><span>Team</span>
              <span class="right">Place</span><span class="right">Kills</span>
              <span class="right">Bonus</span><span class="right">Penalty</span>
              <span class="right">Pl. pts</span><span class="right">Total</span>
            </div>
            <div class="col" id="result-rows" style="gap:6px">
              ${rows.map((row, i) => resultRow(row, i, canScore)).join('')}
            </div>
          </div>
        </div>

        ${canScore ? `
          <div class="row-between mt-3 wrap" style="gap:10px">
            <div class="small muted">
              Match total: <b class="mono" id="grand-total">0</b> points ·
              <b class="mono" id="grand-kills">0</b> kills
            </div>
            <div class="row gap-sm">
              ${match.results.length ? `<button class="btn btn-danger btn-sm" data-act="clear">${icon('trash', 13)} Clear</button>` : ''}
              <button class="btn" data-act="save" data-status="live" data-busy-label="Saving">Save as live</button>
              <button class="btn btn-primary" data-act="save" data-status="completed" data-busy-label="Saving">
                ${icon('check', 15)} Save &amp; complete
              </button>
            </div>
          </div>` : '<div class="info-box mt-2">' + icon('lock', 15) + '<div>Your role cannot enter results.</div></div>'}
      </div>
    </div>`;
}

/** One row per participating team, prefilled with any saved result. */
function buildRows(match) {
  const saved = new Map(match.results.map((r) => [r.team_id, r]));
  const rows = match.participants.map((p) => ({
    team_id: p.team_id,
    name: p.name,
    tag: p.tag,
    logo_url: p.logo_url,
    result: saved.get(p.team_id) || null,
  }));

  // Teams with a result already recorded sort to the top, in finishing order.
  rows.sort((a, b) => {
    const pa = a.result?.placement ?? 999;
    const pb = b.result?.placement ?? 999;
    return pa - pb || a.name.localeCompare(b.name);
  });
  return rows;
}

function resultRow(row, index, canScore) {
  const r = row.result;
  const ro = canScore ? '' : 'disabled';
  return `
    <div class="result-row" data-result-row data-team="${row.team_id}">
      <span class="dim tiny num">${index + 1}</span>
      ${teamCell(row, { size: 'sm' })}
      <input class="input input-sm num right" data-field="placement" type="number" min="1" ${ro}
             value="${r?.placement ?? ''}" placeholder="--">
      <input class="input input-sm num right" data-field="kills" type="number" min="0" ${ro}
             value="${r?.kills ?? 0}">
      <input class="input input-sm num right" data-field="bonus_points" type="number" step="0.5" ${ro}
             value="${r?.bonus_points ?? 0}">
      <input class="input input-sm num right" data-field="penalty_points" type="number" step="0.5" min="0" ${ro}
             value="${r?.penalty_points ?? 0}">
      <span class="right small muted mono" data-out="placement_points">0</span>
      <span class="result-total" data-out="total">0</span>
    </div>`;
}

function detailsCard(match, canEdit) {
  return `
    <div class="card">
      <div class="card-head"><h2>Match details</h2></div>
      <div class="card-body">
        <form id="match-details" class="col" style="gap:12px">
          <div class="field">
            <label class="label" for="m-when">Date &amp; time</label>
            <input class="input" id="m-when" name="scheduled_at" type="datetime-local" ${canEdit ? '' : 'disabled'}
                   value="${esc((match.scheduled_at || '').replace(' ', 'T').slice(0, 16))}">
          </div>
          <div class="field">
            <label class="label" for="m-map">Map</label>
            <input class="input" id="m-map" name="map" value="${esc(match.map || '')}" ${canEdit ? '' : 'disabled'}>
          </div>
          <div class="divider" style="margin:2px 0"></div>
          <div class="field">
            <label class="label" for="m-room">Room ID</label>
            <input class="input mono" id="m-room" name="room_id" value="${esc(match.room_id || '')}"
                   placeholder="1234567" ${canEdit ? '' : 'disabled'}>
          </div>
          <div class="field">
            <label class="label" for="m-pass">Room password</label>
            <input class="input mono" id="m-pass" name="room_password" value="${esc(match.room_password || '')}"
                   placeholder="secret" ${canEdit ? '' : 'disabled'}>
          </div>
          <div class="field">
            <label class="label" for="m-reveal">Reveal to public at</label>
            <input class="input" id="m-reveal" name="credentials_reveal_at" type="datetime-local" ${canEdit ? '' : 'disabled'}
                   value="${esc((match.credentials_reveal_at || '').replace(' ', 'T').slice(0, 16))}">
            <span class="hint">Leave blank to show them immediately.</span>
          </div>
          <div class="field">
            <label class="label" for="m-notes">Notes</label>
            <textarea class="textarea" id="m-notes" name="notes" rows="2" ${canEdit ? '' : 'disabled'}>${esc(match.notes || '')}</textarea>
          </div>
          ${canEdit ? `<button type="button" class="btn btn-primary btn-block" data-act="save-details" data-busy-label="Saving">
            Save details</button>` : ''}
        </form>
      </div>
    </div>`;
}

function lineupCard(match) {
  return `
    <div class="card">
      <div class="card-head"><h2>Lineup</h2><span class="small dim">${match.participants.length} teams</span></div>
      <div class="card-body tight">
        <div class="col" style="gap:0">
          ${match.participants.map((p, i) => `
            <div class="row" style="gap:9px;padding:8px 15px;border-bottom:1px solid var(--border-soft)">
              <span class="dim tiny num" style="width:18px">${i + 1}</span>
              ${teamCell(p, { size: 'sm' })}
            </div>`).join('')}
        </div>
      </div>
    </div>`;
}

/**
 * Optional per-player kills. Team results stand on their own; this is what
 * turns "team kills" into real individual numbers for the kill and MVP
 * leaderboards, so it is collapsed until an organizer wants it.
 */
function playerStatsCard({ playerStats, match }, canScore) {
  const teams = playerStats?.teams || [];
  if (!teams.length) return '';
  const recorded = teams.some((t) => t.players.some((p) => p.kills > 0));

  return `
    <div class="card">
      <div class="card-head">
        <div>
          <h2>Per-player stats ${recorded ? '<span class="badge badge-completed">Recorded</span>' : '<span class="badge badge-neutral">Optional</span>'}</h2>
        </div>
        ${canScore ? `<button class="btn btn-sm" data-act="toggle-pstats">${recorded ? 'Hide' : 'Record per-player kills'}</button>` : ''}
      </div>
      <div class="card-body" id="pstats-body" ${recorded ? '' : 'hidden'}>
        <div class="info-box mb-2">
          ${icon('info', 15)}
          <div>Optional. Team points are unaffected — this only powers the individual kill board and MVP.</div>
        </div>
        <div class="grid grid-2" style="gap:16px">
          ${teams.map((team) => `
            <div>
              <div class="row mb-1" style="gap:8px">
                ${teamCell(team, { size: 'sm' })}
              </div>
              <div class="pstat-row result-head mb-1">
                <span>Player</span><span class="right">Kills</span><span class="right">Damage</span>
              </div>
              <div class="col" style="gap:6px">
                ${team.players.map((p) => `
                  <div class="pstat-row" data-pstat-row data-player="${p.id}">
                    <span class="small truncate">
                      ${p.is_captain ? `<span style="color:var(--gold)">${icon('crown', 11)}</span> ` : ''}${esc(p.name)}
                      ${p.is_substitute ? '<span class="role-pill substitute">sub</span>' : ''}
                    </span>
                    <input class="input input-sm num right" data-pfield="kills" type="number" min="0"
                           value="${p.kills}" ${canScore ? '' : 'disabled'}>
                    <input class="input input-sm num right" data-pfield="damage" type="number" min="0"
                           value="${p.damage}" ${canScore ? '' : 'disabled'}>
                  </div>`).join('')}
                ${team.players.length ? '' : '<div class="small dim">No roster recorded for this team.</div>'}
              </div>
            </div>`).join('')}
        </div>
        ${canScore ? `
          <div class="row-between mt-3">
            <span class="small dim">Leave everything at zero to skip.</span>
            <button class="btn btn-primary" data-act="save-pstats" data-busy-label="Saving">Save player stats</button>
          </div>` : ''}
      </div>
    </div>`;
}

// -------------------------------------------------------------- calculation --
/** Mirrors src/services/scoring.js so the grid updates as you type. */
function recalculateAll(root, scoring) {
  const table = scoring.placementPoints || {};
  const killPoints = Number(scoring.killPoints) || 0;
  const winBonus = Number(scoring.winBonus) || 0;
  const fallback = Number(scoring.defaultPlacementPoints) || 0;

  let grandTotal = 0;
  let grandKills = 0;
  const seen = new Map();

  for (const row of $$('[data-result-row]', root)) {
    const read = (field) => {
      const value = row.querySelector(`[data-field=${field}]`)?.value;
      return value === '' || value === undefined ? null : Number(value);
    };
    const placement = read('placement');
    const kills = read('kills') || 0;
    const bonus = read('bonus_points') || 0;
    const penalty = read('penalty_points') || 0;

    const placementPoints = placement === null
      ? 0
      : (table[placement] !== undefined ? Number(table[placement]) : fallback);
    const total = placementPoints + kills * killPoints + bonus + (placement === 1 ? winBonus : 0) - penalty;

    row.querySelector('[data-out=placement_points]').textContent = points(placementPoints);
    row.querySelector('[data-out=total]').textContent = points(total);

    if (placement !== null) seen.set(placement, (seen.get(placement) || 0) + 1);
    grandTotal += total;
    grandKills += kills;

    // Flag a duplicate placement before the organizer tries to save.
    const field = row.querySelector('[data-field=placement]');
    field.classList.toggle('err', placement !== null && seen.get(placement) > 1);
  }

  // Second pass so every duplicate is marked, not just the later one.
  for (const row of $$('[data-result-row]', root)) {
    const field = row.querySelector('[data-field=placement]');
    const value = field.value === '' ? null : Number(field.value);
    field.classList.toggle('err', value !== null && seen.get(value) > 1);
  }

  const totalEl = $('#grand-total', root);
  const killsEl = $('#grand-kills', root);
  if (totalEl) totalEl.textContent = points(grandTotal);
  if (killsEl) killsEl.textContent = String(grandKills);
}

function collectEntries(root) {
  return $$('[data-result-row]', root).map((row) => {
    const read = (field) => {
      const value = row.querySelector(`[data-field=${field}]`)?.value;
      return value === '' || value === undefined ? null : Number(value);
    };
    return {
      team_id: Number(row.dataset.team),
      placement: read('placement'),
      kills: read('kills') || 0,
      bonus_points: read('bonus_points') || 0,
      penalty_points: read('penalty_points') || 0,
    };
  });
}

/** Automatic leaderboard, with per-group tables and tiebreaker controls. */
import { api, download, qs } from '../lib/api.js';
import { $, delegate, esc, html, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import {
  barChart, emptyState, modal, movementIndicator, points, rankPill, teamCell, toast, withBusy,
} from '../lib/ui.js';
import { can } from '../main.js';

let view = { stage: '', split: 'overall' };

export default {
  title: 'Leaderboard',

  async load(ctx) {
    const id = Number(ctx.params.id);
    view = { stage: ctx.query.stage || '', split: ctx.query.split || 'overall' };
    const [board, bundle, meta] = await Promise.all([
      api.get(`/api/tournaments/${id}/leaderboard${qs({ stage: view.stage, split: view.split === 'groups' ? 'groups' : '' })}`),
      api.get(`/api/tournaments/${id}`),
      api.get('/api/meta'),
    ]);
    return { tournamentId: id, ...board, stages: bundle.stages, settings: bundle.settings, meta };
  },

  render(data) {
    const { standings, groups, stages, tournamentId, tiebreakers, meta } = data;
    const played = standings.filter((s) => s.matches_played > 0);

    return html`
      <div class="page">
        <div class="page-head">
          <div class="page-title">
            <h1>Leaderboard</h1>
            <p class="muted small" style="margin:0">
              Calculated from match results every time this page loads -- nothing is stored or entered by hand.
            </p>
          </div>
          <div class="row wrap">
            ${can('tournament:write') ? raw(`<button class="btn" data-act="tiebreakers">${icon('settings', 15)} Tie-breakers</button>`) : ''}
            <button class="btn" data-act="export-csv">${raw(icon('download', 15))} CSV</button>
            <button class="btn btn-primary" data-act="export-pdf">${raw(icon('download', 15))} PDF</button>
          </div>
        </div>

        <div class="card">
          <div class="card-head" style="gap:10px;flex-wrap:wrap">
            <div class="row gap-sm wrap">
              <select class="select input-sm" id="stage-filter" style="width:auto">
                <option value="">All stages</option>
                ${raw(stages.map((s) => `<option value="${s.id}" ${String(view.stage) === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join(''))}
              </select>
              <div class="btn-group">
                <button class="btn ${view.split === 'overall' ? 'active' : ''}" data-act="split" data-value="overall">Overall</button>
                <button class="btn ${view.split === 'groups' ? 'active' : ''}" data-act="split" data-value="groups">By group</button>
              </div>
            </div>
            <div class="grow"></div>
            <div class="small dim">
              Order: ${raw((tiebreakers || []).map((k) => esc(meta.tiebreakers[k] || k)).join(' → '))}
            </div>
          </div>

          <div class="card-body tight">
            ${!played.length ? raw(emptyState({
              icon: 'trophy',
              title: 'No results yet',
              message: 'Enter a match result and the standings build themselves, tie-breakers included.',
              action: `<a class="btn btn-primary mt-2" href="/admin/t/${tournamentId}/matches">Go to Match Center</a>`,
            })) : view.split === 'groups' && groups?.length
              ? raw(groups.map((g) => groupBlock(g)).join(''))
              : raw(standingsTable(standings))}
          </div>
        </div>

        ${played.length ? raw(`
          <div class="grid grid-2 mt-3">
            <div class="card">
              <div class="card-head"><h2>Points spread</h2></div>
              <div class="card-body">
                ${barChart(played.slice(0, 16).map((s) => ({ label: s.tag || s.team_name.slice(0, 6), value: s.total_points })), { height: 160, format: points })}
              </div>
            </div>
            <div class="card">
              <div class="card-head"><h2>Kill leaders</h2></div>
              <div class="card-body tight">
                <table class="data compact">
                  <tbody>
                    ${[...played].sort((a, b) => b.total_kills - a.total_kills).slice(0, 8).map((s, i) => `
                      <tr>
                        <td style="width:44px">${rankPill(i + 1)}</td>
                        <td>${teamCell({ name: s.team_name, tag: s.tag, logo_url: s.logo_url }, { size: 'sm' })}</td>
                        <td class="num dim small">${s.avg_kills} avg</td>
                        <td class="num strong">${s.total_kills}</td>
                      </tr>`).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>`) : ''}
      </div>`;
  },

  mounted(data, ctx, root) {
    const reload = () => ctx.navigate(`/admin/t/${data.tournamentId}/leaderboard${qs(view)}`, { replace: true });

    $('#stage-filter', root)?.addEventListener('change', (e) => { view.stage = e.target.value; reload(); });

    delegate(root, {
      split: (el) => { view.split = el.dataset.value; reload(); },
      'export-csv': () => download(`/api/tournaments/${data.tournamentId}/export/leaderboard.csv`),
      'export-pdf': () => download(`/api/tournaments/${data.tournamentId}/export/leaderboard.pdf`),
      tiebreakers: () => tiebreakerDialog(data, ctx),
    });
  },
};

function standingsTable(standings) {
  return `
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width:52px">Rank</th>
            <th>Team</th>
            <th>Group</th>
            <th class="num" title="Matches played">Pld</th>
            <th class="num" title="Wins / WWCD">W</th>
            <th class="num">Place</th>
            <th class="num">Kill pts</th>
            <th class="num">Bonus</th>
            <th class="num">Pen.</th>
            <th class="num">Kills</th>
            <th class="num">Avg K</th>
            <th class="num">Avg pts</th>
            <th class="num">Total</th>
            <th style="width:46px"></th>
          </tr>
        </thead>
        <tbody>
          ${standings.map((s) => `
            <tr class="${s.status === 'qualified' ? 'is-qualified' : ''} ${s.status === 'eliminated' ? 'is-eliminated' : ''}">
              <td class="keep">${rankPill(s.rank)}</td>
              <td class="keep">${teamCell({ name: s.team_name, tag: s.tag, logo_url: s.logo_url })}</td>
              <td>${s.group_name ? `<span class="badge badge-neutral">${esc(s.group_name)}</span>` : '<span class="dim">--</span>'}</td>
              <td class="num">${s.matches_played}</td>
              <td class="num">${s.wins ? `<span style="color:var(--gold);font-weight:650">${s.wins}</span>` : '0'}</td>
              <td class="num">${points(s.placement_points)}</td>
              <td class="num">${points(s.kill_points)}</td>
              <td class="num ${s.bonus_points ? '' : 'dim'}">${points(s.bonus_points)}</td>
              <td class="num ${s.penalty_points ? '' : 'dim'}" ${s.penalty_points ? 'style="color:var(--danger)"' : ''}>
                ${s.penalty_points ? `-${points(s.penalty_points)}` : '0'}</td>
              <td class="num">${s.total_kills}</td>
              <td class="num dim">${s.avg_kills}</td>
              <td class="num dim">${points(s.avg_points)}</td>
              <td class="num strong" style="font-size:14px">${points(s.total_points)}</td>
              <td>${movementIndicator(s.movement)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function groupBlock({ group, standings }) {
  return `
    <div style="padding:11px 16px;border-bottom:1px solid var(--border-soft);background:rgba(11,14,21,0.5)">
      <span class="small" style="font-weight:650;text-transform:uppercase;letter-spacing:0.05em;color:var(--primary-2)">
        ${esc(group.name)}</span>
      <span class="tiny dim"> · ${standings.length} teams</span>
    </div>
    <div class="table-wrap">
      <table class="data compact">
        <thead><tr><th style="width:48px">#</th><th>Team</th><th class="num">Pld</th><th class="num">W</th>
          <th class="num">Kills</th><th class="num">Total</th></tr></thead>
        <tbody>
          ${standings.map((s) => `
            <tr>
              <td>${rankPill(s.rank)}</td>
              <td>${teamCell({ name: s.team_name, tag: s.tag, logo_url: s.logo_url }, { size: 'sm' })}</td>
              <td class="num">${s.matches_played}</td>
              <td class="num">${s.wins}</td>
              <td class="num">${s.total_kills}</td>
              <td class="num strong">${points(s.total_points)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/** Reorder the tie-breakers by moving entries up and down. */
function tiebreakerDialog(data, ctx) {
  const all = data.meta.tiebreakers;
  let order = [...(data.tiebreakers || [])];

  const listMarkup = () => order.map((key, i) => `
    <div class="row" style="gap:8px;padding:7px 9px;background:var(--elev);border:1px solid var(--border);border-radius:9px">
      <span class="rank" style="min-width:22px;height:22px;font-size:11px">${i + 1}</span>
      <span class="grow small">${esc(all[key] || key)}</span>
      <button class="btn btn-ghost btn-icon" data-move="up" data-key="${key}" ${i === 0 ? 'disabled' : ''}>${icon('arrowUp', 13)}</button>
      <button class="btn btn-ghost btn-icon" data-move="down" data-key="${key}" ${i === order.length - 1 ? 'disabled' : ''}>${icon('arrowDown', 13)}</button>
      <button class="btn btn-ghost btn-icon" data-remove="${key}">${icon('close', 13)}</button>
    </div>`).join('');

  const availableMarkup = () => Object.entries(all)
    .filter(([key]) => !order.includes(key))
    .map(([key, label]) => `<button class="chip" data-add="${key}">${icon('plus', 12)} ${esc(label)}</button>`)
    .join('') || '<span class="small dim">Every tie-breaker is in use.</span>';

  modal({
    title: 'Tie-breaker order',
    body: `
      <p class="muted small">Applied top-down until two teams are separated. Total points is always considered first.</p>
      <div class="col mt-2" id="tb-list" style="gap:7px">${listMarkup()}</div>
      <div class="divider"></div>
      <div class="label mb-1">Add a tie-breaker</div>
      <div class="row wrap gap-sm" id="tb-available">${availableMarkup()}</div>`,
    footer: `
      <button class="btn" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="save-tb" data-busy-label="Saving">Save order</button>`,
    onMount(overlay, close) {
      const redraw = () => {
        overlay.querySelector('#tb-list').innerHTML = listMarkup();
        overlay.querySelector('#tb-available').innerHTML = availableMarkup();
      };
      overlay.addEventListener('click', (e) => {
        const move = e.target.closest('[data-move]');
        const remove = e.target.closest('[data-remove]');
        const add = e.target.closest('[data-add]');
        if (move) {
          const i = order.indexOf(move.dataset.key);
          const j = move.dataset.move === 'up' ? i - 1 : i + 1;
          if (j >= 0 && j < order.length) { [order[i], order[j]] = [order[j], order[i]]; redraw(); }
        } else if (remove) {
          order = order.filter((k) => k !== remove.dataset.remove);
          redraw();
        } else if (add) {
          order.push(add.dataset.add);
          redraw();
        }
      });

      overlay.querySelector('#save-tb').addEventListener('click', async (e) => {
        await withBusy(e.currentTarget, async () => {
          await api.patch(`/api/tournaments/${data.tournamentId}/settings`, { tiebreakers: order });
          toast('Tie-breakers updated. Standings re-sorted.', { type: 'success' });
          close();
          ctx.navigate(`/admin/t/${data.tournamentId}/leaderboard${qs(view)}`, { replace: true });
        });
      });
    },
  });
}

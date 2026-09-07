/**
 * Qualification & playoffs: the live cut, locking it in, and generating the
 * next stage from whoever came through.
 */
import { api } from '../lib/api.js';
import { $, delegate, esc, formData, html, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import {
  confirmAction, emptyState, modal, points, rankPill, teamCell, toast, withBusy,
} from '../lib/ui.js';
import { can, invalidateTournament } from '../main.js';

export default {
  title: 'Qualification',

  async load(ctx) {
    const id = Number(ctx.params.id);
    const bundle = await api.get(`/api/tournaments/${id}`);
    const stageId = Number(ctx.query.stage) || bundle.current_stage?.id || bundle.stages[0]?.id;
    if (!stageId) return { tournamentId: id, bundle, stages: bundle.stages, qualification: null };

    const [qualification, nextPreview] = await Promise.all([
      api.get(`/api/stages/${stageId}/qualification`),
      api.get(`/api/stages/${stageId}/next/preview`),
    ]);
    return { tournamentId: id, bundle, stages: bundle.stages, stageId, qualification, nextPreview };
  },

  render(data) {
    const { stages, stageId, qualification, nextPreview, tournamentId } = data;
    if (!qualification) {
      return `<div class="page">${emptyState({ icon: 'target', title: 'No stages yet', message: 'Create a stage first.' })}</div>`;
    }

    const { config, qualified, eliminated, locked, standings } = qualification;
    const isLocked = locked.length > 0;
    const hasResults = standings.some((s) => s.matches_played > 0);

    return html`
      <div class="page">
        <div class="page-head">
          <div class="page-title">
            <h1>Qualification &amp; playoffs</h1>
            <p class="muted small" style="margin:0">
              The cut is recalculated from live standings. Lock it in when the stage is over, then generate the next round.
            </p>
          </div>
          <div class="row wrap">
            <select class="select input-sm" id="stage-picker" style="width:auto">
              ${raw(stages.map((s) => `<option value="${s.id}" ${s.id === stageId ? 'selected' : ''}>${esc(s.name)}</option>`).join(''))}
            </select>
            ${can('qualification:write') ? raw(`
              <button class="btn" data-act="rules">${icon('settings', 15)} Rules</button>
              <button class="btn ${isLocked ? '' : 'btn-primary'}" data-act="lock" ${hasResults ? '' : 'disabled'}>
                ${icon('lock', 15)} ${isLocked ? 'Re-lock cut' : 'Lock qualification'}
              </button>`) : ''}
          </div>
        </div>

        ${raw(ruleSummary(config, isLocked))}

        ${!hasResults ? raw(`
          <div class="warn-box mt-3">${icon('alert', 15)}
            <div>No results recorded for this stage yet, so the cut below is empty. Enter results first.</div>
          </div>`) : ''}

        <div class="grid grid-2 mt-3">
          ${raw(cutColumn('Qualified', qualified, 'success', 'crown'))}
          ${raw(cutColumn('Eliminated', eliminated, 'danger', 'close'))}
        </div>

        ${raw(nextStageCard(data, nextPreview, isLocked))}
      </div>`;
  },

  mounted(data, ctx, root) {
    $('#stage-picker', root)?.addEventListener('change', (e) => {
      ctx.navigate(`/admin/t/${data.tournamentId}/qualification?stage=${e.target.value}`, { replace: true });
    });

    delegate(root, {
      rules: () => rulesDialog(data, ctx),

      async lock(el) {
        const preview = data.qualification;
        const ok = await confirmAction({
          title: 'Lock qualification',
          message: `${preview.qualified.length} team(s) qualify and ${preview.eliminated.length} are eliminated.`,
          detail: 'Team statuses are stamped and the stage is marked completed. You can re-lock later if results change.',
          confirmLabel: 'Lock it in',
          danger: false,
        });
        if (!ok) return;
        await withBusy(el, async () => {
          const res = await api.post(`/api/stages/${data.stageId}/qualification/lock`, {});
          toast(`${res.qualified.length} teams qualified.`, { type: 'success', title: 'Cut locked' });
          invalidateTournament();
          ctx.navigate(`/admin/t/${data.tournamentId}/qualification?stage=${data.stageId}`, { replace: true });
        });
      },

      'next-stage': () => nextStageDialog(data, ctx),
    });
  },
};

// ------------------------------------------------------------------ pieces --
function ruleSummary(config, isLocked) {
  const description = {
    top_overall: `Top ${config.count} teams overall qualify.`,
    top_per_group: `Top ${config.perGroup} from each group qualify.`,
    all: 'Every team advances.',
    custom: `${config.customTeamIds.length} hand-picked team(s) qualify.`,
  }[config.mode];

  return `
    <div class="card">
      <div class="card-body" style="padding:13px 16px">
        <div class="row-between wrap" style="gap:12px">
          <div class="row" style="gap:10px">
            ${icon('target', 17)}
            <div>
              <div style="font-weight:620">${esc(description)}</div>
              <div class="tiny dim">Ranked by the tournament's tie-breaker order.</div>
            </div>
          </div>
          <span class="badge ${isLocked ? 'badge-completed' : 'badge-info'}">
            ${isLocked ? 'Locked' : 'Live preview'}
          </span>
        </div>
      </div>
    </div>`;
}

function cutColumn(title, teams, tone, glyph) {
  return `
    <div class="card">
      <div class="card-head">
        <h2 style="color:var(--${tone})">${icon(glyph, 15)} ${esc(title.toUpperCase())}</h2>
        <span class="badge badge-${tone === 'success' ? 'qualified' : 'eliminated'}">${teams.length}</span>
      </div>
      <div class="card-body tight">
        ${teams.length ? `
          <div class="table-wrap" style="max-height:460px;overflow-y:auto">
            <table class="data compact">
              <tbody>
                ${teams.map((t) => `
                  <tr>
                    <td style="width:48px">${rankPill(t.rank)}</td>
                    <td>${teamCell({ name: t.team_name, tag: t.tag, logo_url: t.logo_url }, { size: 'sm' })}</td>
                    ${t.group_rank ? `<td class="small dim nowrap">${esc(t.group_name || '')} #${t.group_rank}</td>` : '<td></td>'}
                    <td class="num small dim">${t.total_kills} K</td>
                    <td class="num strong">${points(t.total_points)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>`
        : emptyState({ icon: 'info', title: `No ${title.toLowerCase()} teams`, message: 'This updates as results come in.' })}
      </div>
    </div>`;
}

function nextStageCard(data, preview, isLocked) {
  const stage = data.stages.find((s) => s.id === data.stageId);
  const later = data.stages.filter((s) => s.order_index > (stage?.order_index ?? 0));

  return `
    <div class="card mt-3">
      <div class="card-head">
        <h2>Next round</h2>
        ${later.length ? `<span class="small dim">${later.length} later stage(s) already exist</span>` : ''}
      </div>
      <div class="card-body">
        ${later.length ? `
          <div class="row wrap gap-sm mb-2">
            ${later.map((s) => `
              <a class="chip active" href="/admin/t/${data.tournamentId}/qualification?stage=${s.id}">
                ${esc(s.name)} <span class="tiny dim">${s.match_count} matches</span>
              </a>`).join('')}
          </div>` : ''}

        <div class="row-between wrap" style="gap:14px">
          <div class="grow" style="min-width:260px">
            <p class="muted small" style="margin:0">
              ${isLocked
                ? `<b>${preview.qualified.length} team(s)</b> are ready to advance. Generating the next round creates the stage,
                   carries the teams across, seeds them by their finishing position and draws the fixtures.`
                : 'Lock the qualification cut first, then the qualified teams can be carried into the next stage automatically.'}
            </p>
          </div>
          ${can('stages:write') ? `
            <button class="btn btn-primary btn-lg" data-act="next-stage" ${isLocked ? '' : 'disabled'}>
              ${icon('zap', 16)} Generate next round
            </button>` : ''}
        </div>

        ${isLocked && preview.qualified.length ? `
          <div class="divider"></div>
          <div class="label mb-1">Advancing (seeded in this order)</div>
          <div class="row wrap gap-sm">
            ${preview.qualified.map((t, i) => `
              <span class="chip"><span class="rank ${i < 3 ? `r${i + 1}` : ''}"
                style="min-width:20px;height:20px;font-size:10.5px">${i + 1}</span>${esc(t.name)}</span>`).join('')}
          </div>` : ''}
      </div>
    </div>`;
}

// ----------------------------------------------------------------- dialogs --
function rulesDialog(data, ctx) {
  const config = data.qualification.config;

  modal({
    title: 'Qualification rules',
    size: 'narrow',
    body: html`
      <form id="qual-form" class="col" style="gap:14px">
        <div class="field">
          <label class="label" for="q-mode">Rule</label>
          <select class="select" id="q-mode" name="mode">
            <option value="top_overall" ${config.mode === 'top_overall' ? 'selected' : ''}>Top X teams overall</option>
            <option value="top_per_group" ${config.mode === 'top_per_group' ? 'selected' : ''}>Top X from each group</option>
            <option value="all" ${config.mode === 'all' ? 'selected' : ''}>Everyone advances</option>
            <option value="custom" ${config.mode === 'custom' ? 'selected' : ''}>Hand-picked teams</option>
          </select>
        </div>
        <div class="field" id="count-field">
          <label class="label" for="q-count">How many qualify overall</label>
          <input class="input" id="q-count" name="count" type="number" min="1" max="512" value="${config.count}">
        </div>
        <div class="field" id="group-field">
          <label class="label" for="q-per">How many from each group</label>
          <input class="input" id="q-per" name="perGroup" type="number" min="1" max="64" value="${config.perGroup}">
        </div>
        <div id="custom-field">
          <div class="label mb-1">Pick the qualifying teams</div>
          <div class="col" style="gap:6px;max-height:260px;overflow-y:auto">
            ${raw(data.qualification.standings.map((s) => `
              <label class="check">
                <input type="checkbox" data-team="${s.team_id}" ${config.customTeamIds.includes(s.team_id) ? 'checked' : ''}>
                <span class="grow">${esc(s.team_name)}</span>
                <span class="tiny dim">${points(s.total_points)} pts</span>
              </label>`).join(''))}
          </div>
        </div>
      </form>`,
    footer: `
      <button class="btn" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="save-rules" data-busy-label="Saving">Save rules</button>`,
    onMount(overlay, close) {
      const mode = overlay.querySelector('#q-mode');
      const toggle = () => {
        overlay.querySelector('#count-field').classList.toggle('hidden', mode.value !== 'top_overall');
        overlay.querySelector('#group-field').classList.toggle('hidden', mode.value !== 'top_per_group');
        overlay.querySelector('#custom-field').classList.toggle('hidden', mode.value !== 'custom');
      };
      mode.addEventListener('change', toggle);
      toggle();

      overlay.querySelector('#save-rules').addEventListener('click', async (e) => {
        const values = formData(overlay.querySelector('#qual-form'));
        const payload = {
          mode: values.mode,
          count: values.count || 8,
          perGroup: values.perGroup || 3,
          customTeamIds: [...overlay.querySelectorAll('[data-team]:checked')].map((el) => Number(el.dataset.team)),
        };
        await withBusy(e.currentTarget, async () => {
          await api.patch(`/api/stages/${data.stageId}/qualification`, payload);
          toast('Qualification rules updated.', { type: 'success' });
          close();
          ctx.navigate(`/admin/t/${data.tournamentId}/qualification?stage=${data.stageId}`, { replace: true });
        });
      });
    },
  });
}

function nextStageDialog(data, ctx) {
  const count = data.nextPreview.qualified.length;
  const suggested = data.nextPreview.suggested_kind;
  const labels = {
    group_stage: 'Group Stage', round_of_32: 'Round of 32', round_of_16: 'Round of 16',
    quarter_final: 'Quarter Finals', semi_final: 'Semi Finals', grand_final: 'Grand Final', custom: 'Playoffs',
  };

  modal({
    title: 'Generate next round',
    body: html`
      <div class="info-box mb-2">
        ${raw(icon('zap', 15))}
        <div><b>${count} qualified team(s)</b> will be carried into the new stage, seeded by their finishing position,
        and a fresh schedule will be drawn for them.</div>
      </div>

      <form id="next-form" class="grid grid-2" style="gap:14px">
        <div class="field">
          <label class="label" for="n-name">Stage name</label>
          <input class="input" id="n-name" name="name" value="${esc(labels[suggested] || 'Playoffs')}">
        </div>
        <div class="field">
          <label class="label" for="n-kind">Stage type</label>
          <select class="select" id="n-kind" name="kind">
            ${raw(Object.entries(labels).map(([value, label]) =>
              `<option value="${value}" ${value === suggested ? 'selected' : ''}>${esc(label)}</option>`).join(''))}
          </select>
        </div>
        <div class="field">
          <label class="label" for="n-tpm">Teams per match</label>
          <input class="input" id="n-tpm" name="teams_per_match" type="number" min="2" max="128" value="${Math.min(count, 16)}">
        </div>
        <div class="field">
          <label class="label" for="n-mpr">Number of matches</label>
          <input class="input" id="n-mpr" name="matches_per_round" type="number" min="1" max="60" value="6">
        </div>
        <div class="field">
          <label class="label" for="n-start">Start date</label>
          <input class="input" id="n-start" name="startDate" type="date">
        </div>
        <div class="field">
          <label class="label" for="n-rounds">Rounds</label>
          <input class="input" id="n-rounds" name="num_rounds" type="number" min="1" max="20" value="1">
        </div>
      </form>`,
    footer: `
      <button class="btn" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="do-next" data-busy-label="Generating">Create stage &amp; fixtures</button>`,
    onMount(overlay, close) {
      overlay.querySelector('#do-next').addEventListener('click', async (e) => {
        const values = formData(overlay.querySelector('#next-form'));
        await withBusy(e.currentTarget, async () => {
          const res = await api.post(`/api/stages/${data.stageId}/next`, values);
          toast(`${res.stage.name} created with ${res.matches} match(es).`, { type: 'success', title: 'Next round ready' });
          res.warnings?.forEach((w) => toast(w, { type: 'info', timeout: 6500 }));
          close();
          invalidateTournament();
          ctx.navigate(`/admin/t/${data.tournamentId}/fixtures`);
        });
      });
    },
  });
}

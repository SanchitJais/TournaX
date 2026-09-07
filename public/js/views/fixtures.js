/** Automatic fixture generation: configure, preview, commit, regenerate. */
import { api, download } from '../lib/api.js';
import { $, delegate, esc, formData, html, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import {
  confirmAction, emptyState, formatDate, formatTime, modal, statusBadge, toast, withBusy,
} from '../lib/ui.js';
import { can } from '../main.js';

export default {
  title: 'Fixtures',

  async load(ctx) {
    const id = Number(ctx.params.id);
    const [bundle, matches, teams] = await Promise.all([
      api.get(`/api/tournaments/${id}`),
      api.get(`/api/tournaments/${id}/matches`),
      api.get(`/api/tournaments/${id}/teams`),
    ]);
    return {
      tournamentId: id,
      tournament: bundle.tournament,
      settings: bundle.settings,
      stages: bundle.stages,
      matches: matches.matches,
      teamCount: teams.teams.length,
    };
  },

  render(data) {
    const { matches, stages, teamCount, tournament } = data;
    const editable = can('fixtures:write');
    const activeStage = stages.find((s) => s.status === 'live') || stages[0];

    return html`
      <div class="page">
        <div class="page-head">
          <div class="page-title">
            <h1>Fixtures</h1>
            <p class="muted small" style="margin:0">
              ${matches.length
                ? `${matches.length} match(es) scheduled across ${stages.length} stage(s).`
                : 'Generate a complete, balanced schedule in one click.'}
            </p>
          </div>
          ${editable ? raw(`
            <div class="row wrap">
              ${matches.length ? `<button class="btn" data-act="export">${icon('download', 15)} Schedule</button>` : ''}
              <button class="btn ${matches.length ? '' : 'btn-primary'}" data-act="preview">${icon('eye', 15)} Preview draw</button>
              <button class="btn btn-primary" data-act="generate">
                ${icon('zap', 15)} ${matches.length ? 'Regenerate fixtures' : 'Generate fixtures automatically'}
              </button>
            </div>`) : ''}
        </div>

        ${teamCount < 2 ? raw(`
          <div class="warn-box mb-3">
            ${icon('alert', 15)}
            <div>Add at least two teams before generating fixtures.
              <a href="/admin/t/${data.tournamentId}/teams" style="color:inherit;text-decoration:underline">Go to teams</a>.</div>
          </div>`) : ''}

        ${raw(configCard(data, activeStage, editable))}

        <div class="card mt-3">
          <div class="card-head">
            <h2>Schedule</h2>
            ${matches.length ? raw(`<span class="small dim">${matches.length} matches</span>`) : ''}
          </div>
          <div class="card-body tight">
            ${matches.length ? raw(scheduleTable(matches, data.tournamentId)) : raw(emptyState({
              icon: 'calendar',
              title: 'No fixtures yet',
              message: `The generator balances lobbies, spreads opponents across rounds and lays out dates and times for you.`,
              action: editable && teamCount >= 2
                ? `<button class="btn btn-primary mt-2" data-act="generate">${icon('zap', 15)} Generate fixtures automatically</button>`
                : '',
            }))}
          </div>
        </div>
      </div>`;
  },

  mounted(data, ctx, root) {
    const stageSelect = $('#stage-select', root);
    const currentStage = () => data.stages.find((s) => s.id === Number(stageSelect?.value)) || data.stages[0];

    delegate(root, {
      export: () => download(`/api/tournaments/${data.tournamentId}/export/schedule.pdf`),
      preview: () => runPreview(data, currentStage(), root),
      generate: () => runGenerate(data, ctx, currentStage(), root),
    });
  },
};

// ------------------------------------------------------------------ config --
function configCard(data, stage, editable) {
  const { settings, tournament, stages } = data;
  const opts = settings.fixture_options || {};
  const sched = settings.schedule_options || {};
  const isBracket = tournament.format_type === 'single_elimination';

  return `
    <div class="card">
      <div class="card-head"><h2>Draw settings</h2>
        <span class="small dim">Applied when you generate</span>
      </div>
      <div class="card-body">
        <form id="fixture-config" class="grid grid-4" style="gap:14px">
          <div class="field">
            <label class="label" for="stage-select">Stage</label>
            <select class="select" id="stage-select" name="stage_id">
              ${stages.map((s) => `<option value="${s.id}" ${s.id === stage?.id ? 'selected' : ''}>
                ${esc(s.name)}${s.match_count ? ` (${s.match_count} matches)` : ''}</option>`).join('')}
            </select>
          </div>
          ${isBracket ? '' : `
            <div class="field">
              <label class="label" for="f-groups">Groups</label>
              <input class="input" id="f-groups" name="num_groups" type="number" min="1" max="32" value="${stage?.num_groups || 1}">
            </div>
            <div class="field">
              <label class="label" for="f-rounds">Rounds</label>
              <input class="input" id="f-rounds" name="num_rounds" type="number" min="1" max="60" value="${stage?.num_rounds || 1}">
            </div>
            <div class="field">
              <label class="label" for="f-mpr">Matches per round</label>
              <input class="input" id="f-mpr" name="matches_per_round" type="number" min="1" max="60" value="${stage?.matches_per_round || 1}">
            </div>
            <div class="field">
              <label class="label" for="f-tpm">Teams per match</label>
              <input class="input" id="f-tpm" name="teams_per_match" type="number" min="2" max="128" value="${stage?.teams_per_match || 16}">
            </div>`}
          <div class="field">
            <label class="label" for="f-start">Start date</label>
            <input class="input" id="f-start" name="start_date" type="date" value="${esc((tournament.start_date || '').slice(0, 10))}">
          </div>
          <div class="field">
            <label class="label" for="f-time">First match</label>
            <input class="input" id="f-time" name="firstMatchTime" type="time" value="${esc(sched.firstMatchTime || '19:00')}">
          </div>
          <div class="field">
            <label class="label" for="f-gap">Gap (minutes)</label>
            <input class="input" id="f-gap" name="matchGapMinutes" type="number" min="5" max="600" value="${sched.matchGapMinutes || 60}">
          </div>
          <div class="field">
            <label class="label" for="f-perday">Matches per day</label>
            <input class="input" id="f-perday" name="matchesPerDay" type="number" min="1" max="30" value="${sched.matchesPerDay || 4}">
          </div>
          ${isBracket ? '' : `
            <div class="field">
              <label class="label" for="f-mode">Lobby assignment</label>
              <select class="select" id="f-mode" name="mode">
                <option value="rotating" ${opts.mode === 'rotating' ? 'selected' : ''}>Rotating (spread opponents)</option>
                <option value="static" ${opts.mode === 'static' ? 'selected' : ''}>Fixed groups</option>
              </select>
            </div>`}
          <div class="field" style="justify-content:flex-end">
            <label class="check"><input type="checkbox" name="seeded" ${opts.seeded ? 'checked' : ''}> Use seeds</label>
          </div>
          <div class="field" style="justify-content:flex-end">
            <label class="check"><input type="checkbox" name="fixedSeed"> Reproducible draw</label>
            <span class="hint">Same result every time.</span>
          </div>
        </form>
        ${editable ? '' : '<div class="info-box mt-2">' + icon('lock', 15) + '<div>Your role cannot change fixtures.</div></div>'}
      </div>
    </div>`;
}

/** Read the config form into the payload both preview and generate use. */
function readConfig(root) {
  const values = formData($('#fixture-config', root));
  return {
    num_groups: values.num_groups,
    num_rounds: values.num_rounds,
    matches_per_round: values.matches_per_round,
    teams_per_match: values.teams_per_match,
    start_date: values.start_date || null,
    schedule: {
      firstMatchTime: values.firstMatchTime,
      matchGapMinutes: values.matchGapMinutes,
      matchesPerDay: values.matchesPerDay,
    },
    options: {
      mode: values.mode || 'rotating',
      seeded: Boolean(values.seeded),
      // A fixed seed makes "regenerate" reproducible; otherwise every draw differs.
      seed: values.fixedSeed ? 20260101 : null,
    },
  };
}

// ----------------------------------------------------------------- actions --
async function runPreview(data, stage, root) {
  const button = root.querySelector('[data-act=preview]');
  const config = readConfig(root);
  await withBusy(button, async () => {
    const preview = await api.post(`/api/stages/${stage.id}/fixtures/preview`, config);
    modal({
      title: `Preview: ${preview.matches.length} matches`,
      size: 'wide',
      body: html`
        ${preview.warnings.length ? raw(`
          <div class="info-box mb-2">${icon('info', 15)}<div>${preview.warnings.map(esc).join('<br>')}</div></div>`) : ''}

        <h3 class="mb-1">Lobbies</h3>
        <div class="lobby-grid mb-3">
          ${raw(preview.groups.map((g) => `
            <div class="lobby">
              <h4>${esc(g.name)} · ${g.teams.length} teams</h4>
              <ol>${g.teams.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>
            </div>`).join(''))}
        </div>

        <h3 class="mb-1">Schedule</h3>
        <div class="table-wrap" style="max-height:340px;overflow-y:auto">
          <table class="data compact">
            <thead><tr><th>Match</th><th>Round</th><th>Group</th><th>Teams</th><th>Date</th><th>Time</th></tr></thead>
            <tbody>
              ${raw(preview.matches.map((m) => `
                <tr>
                  <td class="strong">Match ${m.match_no}</td>
                  <td>${esc(m.round || '--')}</td>
                  <td>${esc(m.group || '--')}</td>
                  <td class="small muted truncate" style="max-width:340px" title="${esc(m.teams.join(', '))}">
                    ${esc(m.teams.slice(0, 4).join(', '))}${m.teams.length > 4 ? ` +${m.teams.length - 4} more` : ''}
                  </td>
                  <td>${formatDate(m.scheduled_at)}</td>
                  <td>${formatTime(m.scheduled_at)}</td>
                </tr>`).join(''))}
            </tbody>
          </table>
        </div>`,
      footer: `
        <span class="small dim grow">Nothing has been saved yet.</span>
        <button class="btn" data-modal-close>Close</button>
        <button class="btn btn-primary" id="commit-preview">Use this schedule</button>`,
      onMount(overlay, close) {
        overlay.querySelector('#commit-preview').addEventListener('click', () => {
          close();
          root.querySelector('[data-act=generate]')?.click();
        });
      },
    });
  });
}

async function runGenerate(data, ctx, stage, root) {
  if (data.teamCount < 2) {
    toast('Add at least two teams first.', { type: 'error' });
    return;
  }
  const existing = data.matches.filter((m) => m.stage_id === stage.id);
  const played = existing.filter((m) => m.status === 'completed').length;

  if (existing.length) {
    const ok = await confirmAction({
      title: 'Regenerate fixtures',
      message: `Replace the ${existing.length} existing match(es) in ${stage.name} with a fresh draw?`,
      detail: played
        ? `${played} of them already have results recorded. Those results will be deleted.`
        : 'The current schedule, including any room details, will be discarded.',
      confirmLabel: 'Regenerate',
      danger: Boolean(played),
    });
    if (!ok) return;
  }

  const button = root.querySelector('[data-act=generate]');
  await withBusy(button, async () => {
    const res = await api.post(`/api/stages/${stage.id}/fixtures/generate`, readConfig(root));
    toast(`${res.matches} fixtures generated.`, { type: 'success', title: 'Schedule ready' });
    if (res.warnings?.length) {
      res.warnings.forEach((w) => toast(w, { type: 'info', timeout: 7000 }));
    }
    ctx.navigate(`/admin/t/${data.tournamentId}/fixtures`, { replace: true });
  });
}

// ------------------------------------------------------------------ table ---
function scheduleTable(matches, tournamentId) {
  const byStage = new Map();
  for (const m of matches) {
    if (!byStage.has(m.stage_name)) byStage.set(m.stage_name, []);
    byStage.get(m.stage_name).push(m);
  }

  return [...byStage.entries()].map(([stageName, list]) => `
    <div style="padding:11px 16px;border-bottom:1px solid var(--border-soft);background:rgba(11,14,21,0.5)">
      <span class="small" style="font-weight:650;letter-spacing:0.04em;text-transform:uppercase;color:var(--primary-2)">
        ${esc(stageName)}</span>
      <span class="tiny dim"> · ${list.length} matches</span>
    </div>
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr><th style="width:88px">Match</th><th>Round</th><th>Group</th><th>Teams</th>
              <th>Map</th><th>Date</th><th>Time</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${list.map((m) => `
            <tr style="cursor:pointer" onclick="location.href='/admin/t/${tournamentId}/matches/${m.id}'">
              <td class="strong">Match ${m.match_no}</td>
              <td class="small muted">${esc(m.round_name || '--')}</td>
              <td>${m.group_name ? `<span class="badge badge-neutral">${esc(m.group_name)}</span>` : '<span class="dim">--</span>'}</td>
              <td class="small muted truncate" style="max-width:330px" title="${esc(m.teams.map((t) => t.name).join(', '))}">
                ${m.teams.length
                  ? `${esc(m.teams.slice(0, 3).map((t) => t.name).join(', '))}${m.teams.length > 3 ? ` <span class="dim">+${m.teams.length - 3} more</span>` : ''}`
                  : '<span class="dim">No teams</span>'}
              </td>
              <td class="small">${esc(m.map || '--')}</td>
              <td class="small nowrap">${formatDate(m.scheduled_at)}</td>
              <td class="small nowrap">${formatTime(m.scheduled_at)}</td>
              <td>${statusBadge(m.status)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`).join('');
}

/** Tournament settings, scoring rules, notifications, templates, danger zone. */
import { api, download } from '../lib/api.js';
import { $, $$, delegate, esc, formData, html, raw, readImage } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { confirmAction, emptyState, modal, toast, toastError, withBusy } from '../lib/ui.js';
import { invalidateTournament } from '../main.js';

export default {
  title: 'Settings',

  async load(ctx) {
    // Reached either as /admin/templates or /admin/t/:id/settings.
    if (!ctx.params.id) {
      const templates = await api.get('/api/templates');
      return { templatesOnly: true, templates: templates.templates };
    }
    const id = Number(ctx.params.id);
    const [bundle, meta, templates] = await Promise.all([
      api.get(`/api/tournaments/${id}`),
      api.get('/api/meta'),
      api.get('/api/templates'),
    ]);
    return { tournamentId: id, ...bundle, meta, templates: templates.templates };
  },

  render(data, ctx) {
    if (data.templatesOnly) {
      return html`
        <div class="page" style="max-width:900px">
          <div class="page-head">
            <div class="page-title">
              <h1>Tournament templates</h1>
              <p class="muted small" style="margin:0">Reusable formats. Pick one when creating a tournament and only enter the teams.</p>
            </div>
            <a class="btn btn-primary" href="/admin/new">${raw(icon('plus', 15))} New tournament</a>
          </div>
          ${raw(templateList(data.templates))}
        </div>`;
    }

    const tab = ctx.query.tab || 'general';
    const tabs = [
      ['general', 'General'],
      ['scoring', 'Scoring'],
      ['schedule', 'Schedule & draw'],
      ['notifications', 'Notifications'],
      ['templates', 'Templates'],
      ['danger', 'Danger zone'],
    ];

    return html`
      <div class="page" style="max-width:1000px">
        <div class="page-head">
          <div class="page-title">
            <h1>Settings</h1>
            <p class="muted small" style="margin:0">Everything from the setup wizard, editable at any time.</p>
          </div>
        </div>

        <div class="tabs mb-3">
          ${raw(tabs.map(([key, label]) => `
            <a class="tab ${tab === key ? 'active' : ''}"
               href="/admin/t/${data.tournamentId}/settings?tab=${key}">${esc(label)}</a>`).join(''))}
        </div>

        ${raw({
          general: () => generalTab(data),
          scoring: () => scoringTab(data),
          schedule: () => scheduleTab(data),
          notifications: () => notificationsTab(data),
          templates: () => `<div class="card"><div class="card-body">
              <div class="row-between mb-2">
                <div><h2>Templates</h2><p class="muted small" style="margin:0">Save this tournament's format for reuse.</p></div>
                <button class="btn btn-primary" data-act="save-template">${icon('plus', 15)} Save as template</button>
              </div>
              ${templateList(data.templates)}
            </div></div>`,
          danger: () => dangerTab(data),
        }[tab]?.() || '')}
      </div>`;
  },

  mounted(data, ctx, root) {
    if (data.templatesOnly) {
      delegate(root, { 'delete-template': (el) => deleteTemplate(el, ctx, '/admin/templates') });
      return;
    }

    let logoData = null;
    let bannerData = null;

    $$('input[type=file][data-image]', root).forEach((input) => {
      input.addEventListener('change', async () => {
        try {
          const dataUrl = await readImage(input);
          if (input.dataset.image === 'logo_url') logoData = dataUrl;
          else bannerData = dataUrl;
          const preview = root.querySelector(`[data-preview="${input.dataset.image}"]`);
          if (preview && dataUrl) preview.innerHTML = `<img src="${dataUrl}" alt="" style="width:100%;height:100%;object-fit:cover">`;
          toast('Image ready. Save to apply.', { type: 'info' });
        } catch (err) { toastError(err); }
      });
    });

    delegate(root, {
      async 'save-general'(el) {
        const values = formData($('#general-form', root));
        await withBusy(el, async () => {
          await api.patch(`/api/tournaments/${data.tournamentId}`, {
            ...values,
            keep_slug: true,
            logo_url: logoData || undefined,
            banner_url: bannerData || undefined,
          });
          invalidateTournament();
          toast('Settings saved.', { type: 'success' });
          ctx.navigate(`/admin/t/${data.tournamentId}/settings?tab=general`, { replace: true });
        });
      },

      async 'save-scoring'(el) {
        const values = formData($('#scoring-form', root));
        const placementPoints = {};
        $$('[data-place]', root).forEach((input) => {
          const value = Number(input.value);
          if (Number.isFinite(value)) placementPoints[input.dataset.place] = value;
        });
        await withBusy(el, async () => {
          await api.patch(`/api/tournaments/${data.tournamentId}/settings`, {
            scoring: {
              placementPoints,
              killPoints: values.killPoints ?? 1,
              winBonus: values.winBonus ?? 0,
              defaultPlacementPoints: values.defaultPlacementPoints ?? 0,
            },
            tiebreakers: $$('[data-tb]:checked', root).map((el2) => el2.dataset.tb),
          });
          toast('Scoring updated. Standings recalculated.', { type: 'success' });
          ctx.navigate(`/admin/t/${data.tournamentId}/settings?tab=scoring`, { replace: true });
        });
      },

      'add-place': () => {
        const host = $('#placement-grid', root);
        const next = $$('[data-place]', root).length + 1;
        host.insertAdjacentHTML('beforeend', placementField(next, 0));
      },

      async 'save-schedule'(el) {
        const values = formData($('#schedule-form', root));
        await withBusy(el, async () => {
          await api.patch(`/api/tournaments/${data.tournamentId}/settings`, {
            schedule_options: {
              firstMatchTime: values.firstMatchTime,
              matchGapMinutes: values.matchGapMinutes,
              matchesPerDay: values.matchesPerDay,
            },
            fixture_options: {
              mode: values.mode,
              seeded: Boolean(values.seeded),
              avoidRepeats: Boolean(values.avoidRepeats),
            },
          });
          toast('Draw and schedule settings saved.', { type: 'success' });
          ctx.navigate(`/admin/t/${data.tournamentId}/settings?tab=schedule`, { replace: true });
        });
      },

      async 'save-notifications'(el) {
        const events = {};
        $$('[data-event]', root).forEach((input) => { events[input.dataset.event] = input.checked; });
        const channels = {};
        $$('[data-channel]', root).forEach((input) => { channels[input.dataset.channel] = input.checked; });
        await withBusy(el, async () => {
          await api.patch(`/api/tournaments/${data.tournamentId}/settings`, { notification_prefs: { events, channels } });
          toast('Notification preferences saved.', { type: 'success' });
        });
      },

      'save-template': () => saveTemplateDialog(data, ctx),
      'delete-template': (el) => deleteTemplate(el, ctx, `/admin/t/${data.tournamentId}/settings?tab=templates`),
      export: (el) => download(el.dataset.url),

      async 'delete-tournament'(el) {
        const ok = await confirmAction({
          title: 'Delete this tournament',
          message: `Permanently delete "${data.tournament.name}"?`,
          detail: 'Teams, fixtures, results, rankings and history are all removed. There is no undo.',
          confirmLabel: 'Delete permanently',
        });
        if (!ok) return;
        try {
          await api.delete(`/api/tournaments/${data.tournamentId}`);
          invalidateTournament();
          toast('Tournament deleted.', { type: 'success' });
          ctx.navigate('/admin');
        } catch (err) { toastError(err); }
      },

      async 'set-status'(el) {
        try {
          await api.patch(`/api/tournaments/${data.tournamentId}`, { status: el.dataset.value, keep_slug: true });
          invalidateTournament();
          toast(`Tournament marked ${el.dataset.value}.`, { type: 'success' });
          ctx.navigate(`/admin/t/${data.tournamentId}/settings?tab=danger`, { replace: true });
        } catch (err) { toastError(err); }
      },
    });
  },
};

// -------------------------------------------------------------------- tabs --
function generalTab({ tournament }) {
  return `
    <div class="card">
      <div class="card-body">
        <form id="general-form" class="grid grid-2" style="gap:14px">
          <div class="field" style="grid-column:1/-1">
            <label class="label" for="s-name">Tournament name</label>
            <input class="input" id="s-name" name="name" value="${esc(tournament.name)}">
          </div>
          <div class="field">
            <label class="label" for="s-game">Game</label>
            <input class="input" id="s-game" name="game" value="${esc(tournament.game)}">
          </div>
          <div class="field">
            <label class="label" for="s-format">Match format</label>
            <input class="input" id="s-format" name="match_format" value="${esc(tournament.match_format)}">
          </div>
          <div class="field">
            <label class="label" for="s-start">Start date</label>
            <input class="input" id="s-start" name="start_date" type="date" value="${esc((tournament.start_date || '').slice(0, 10))}">
          </div>
          <div class="field">
            <label class="label" for="s-end">End date</label>
            <input class="input" id="s-end" name="end_date" type="date" value="${esc((tournament.end_date || '').slice(0, 10))}">
          </div>
          <div class="field">
            <label class="label" for="s-prize">Prize pool</label>
            <input class="input" id="s-prize" name="prize_pool" value="${esc(tournament.prize_pool || '')}">
          </div>
          <div class="field">
            <label class="label">Branding</label>
            <div class="row" style="gap:10px">
              <label class="team-logo lg" data-preview="logo_url" style="cursor:pointer" title="Change logo">
                ${tournament.logo_url ? `<img src="${esc(tournament.logo_url)}" alt="" style="width:100%;height:100%;object-fit:cover">` : icon('plus', 15)}
                <input type="file" accept="image/*" data-image="logo_url" hidden>
              </label>
              <label class="btn btn-sm" style="cursor:pointer">${icon('upload', 14)} Banner
                <input type="file" accept="image/*" data-image="banner_url" hidden></label>
              <span class="team-logo" data-preview="banner_url" style="width:64px;border-radius:8px">
                ${tournament.banner_url ? `<img src="${esc(tournament.banner_url)}" alt="" style="width:100%;height:100%;object-fit:cover">` : ''}
              </span>
            </div>
          </div>
          <div class="field" style="grid-column:1/-1">
            <label class="label" for="s-desc">Description</label>
            <textarea class="textarea" id="s-desc" name="description">${esc(tournament.description || '')}</textarea>
          </div>
          <label class="check" style="grid-column:1/-1">
            <input type="checkbox" name="is_public" ${tournament.is_public ? 'checked' : ''}>
            Visible on the public site
          </label>
        </form>
        <div class="row-between mt-3">
          <span class="small dim">Public URL: <span class="mono">/t/${esc(tournament.slug)}</span></span>
          <button class="btn btn-primary" data-act="save-general" data-busy-label="Saving">Save changes</button>
        </div>
      </div>
    </div>`;
}

function scoringTab({ settings, meta }) {
  const scoring = settings.scoring || {};
  const places = Object.keys(scoring.placementPoints || {}).map(Number).sort((a, b) => a - b);

  return `
    <div class="card">
      <div class="card-body">
        <h2 class="mb-1">Points</h2>
        <p class="muted small">Every total on the leaderboard is derived from these rules.</p>
        <form id="scoring-form" class="grid grid-3 mt-2" style="gap:14px">
          <div class="field">
            <label class="label" for="s-kp">Points per kill</label>
            <input class="input" id="s-kp" name="killPoints" type="number" step="0.5" value="${scoring.killPoints ?? 1}">
          </div>
          <div class="field">
            <label class="label" for="s-wb">Bonus for a win</label>
            <input class="input" id="s-wb" name="winBonus" type="number" step="0.5" value="${scoring.winBonus ?? 0}">
          </div>
          <div class="field">
            <label class="label" for="s-dp">Points below the table</label>
            <input class="input" id="s-dp" name="defaultPlacementPoints" type="number" step="0.5" value="${scoring.defaultPlacementPoints ?? 0}">
          </div>
        </form>

        <div class="divider"></div>
        <div class="row-between mb-2">
          <h3>Placement points</h3>
          <button class="btn btn-sm" data-act="add-place">${icon('plus', 13)} Add placement</button>
        </div>
        <div class="grid" id="placement-grid" style="grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:10px">
          ${places.map((p) => placementField(p, scoring.placementPoints[p])).join('')}
        </div>

        <div class="divider"></div>
        <h3 class="mb-1">Tie-breakers</h3>
        <p class="muted small">Applied in the order listed on the leaderboard page.</p>
        <div class="grid grid-2 mt-2">
          ${Object.entries(meta.tiebreakers).map(([key, label]) => `
            <label class="check">
              <input type="checkbox" data-tb="${key}" ${settings.tiebreakers?.includes(key) ? 'checked' : ''}>
              ${esc(label)}
            </label>`).join('')}
        </div>

        <div class="row-between mt-3">
          <span class="small dim">Changing scoring re-ranks every existing result.</span>
          <button class="btn btn-primary" data-act="save-scoring" data-busy-label="Saving">Save scoring</button>
        </div>
      </div>
    </div>`;
}

const placementField = (place, value) => `
  <div class="field">
    <label class="label" for="pp-${place}">${ordinal(place)}</label>
    <input class="input input-sm num" id="pp-${place}" data-place="${place}" type="number" step="0.5" value="${value ?? 0}">
  </div>`;

function scheduleTab({ settings }) {
  const sched = settings.schedule_options || {};
  const fixture = settings.fixture_options || {};
  return `
    <div class="card">
      <div class="card-body">
        <h2 class="mb-2">Schedule defaults</h2>
        <form id="schedule-form" class="grid grid-3" style="gap:14px">
          <div class="field">
            <label class="label" for="sc-first">First match time</label>
            <input class="input" id="sc-first" name="firstMatchTime" type="time" value="${esc(sched.firstMatchTime || '19:00')}">
          </div>
          <div class="field">
            <label class="label" for="sc-gap">Minutes between matches</label>
            <input class="input" id="sc-gap" name="matchGapMinutes" type="number" min="5" max="600" value="${sched.matchGapMinutes ?? 60}">
          </div>
          <div class="field">
            <label class="label" for="sc-day">Matches per day</label>
            <input class="input" id="sc-day" name="matchesPerDay" type="number" min="1" max="30" value="${sched.matchesPerDay ?? 4}">
          </div>
          <div class="field">
            <label class="label" for="sc-mode">Lobby assignment</label>
            <select class="select" id="sc-mode" name="mode">
              <option value="rotating" ${fixture.mode === 'rotating' ? 'selected' : ''}>Rotating lobbies</option>
              <option value="static" ${fixture.mode === 'static' ? 'selected' : ''}>Fixed groups</option>
            </select>
          </div>
          <label class="check" style="align-self:flex-end">
            <input type="checkbox" name="seeded" ${fixture.seeded ? 'checked' : ''}> Draw using team seeds
          </label>
          <label class="check" style="align-self:flex-end">
            <input type="checkbox" name="avoidRepeats" ${fixture.avoidRepeats !== false ? 'checked' : ''}> Avoid repeat matchups
          </label>
        </form>
        <div class="row-between mt-3">
          <span class="small dim">These are the defaults the fixture generator starts from.</span>
          <button class="btn btn-primary" data-act="save-schedule" data-busy-label="Saving">Save</button>
        </div>
      </div>
    </div>`;
}

function notificationsTab({ settings, meta }) {
  const prefs = settings.notification_prefs || {};
  const channels = [
    ['web', 'In-app notifications', true],
    ['email', 'Email', false],
    ['telegram', 'Telegram bot', false],
    ['discord', 'Discord webhook', false],
    ['whatsapp', 'WhatsApp', false],
  ];

  return `
    <div class="card">
      <div class="card-body">
        <h2 class="mb-1">Events</h2>
        <p class="muted small">Choose what raises a notification.</p>
        <div class="grid grid-2 mt-2">
          ${Object.entries(meta.notificationEvents).map(([key, label]) => `
            <label class="check">
              <input type="checkbox" data-event="${key}" ${prefs.events?.[key] !== false ? 'checked' : ''}>
              ${esc(label)}
            </label>`).join('')}
        </div>

        <div class="divider"></div>
        <h2 class="mb-1">Channels</h2>
        <p class="muted small">
          In-app notifications work out of the box. The other channels are wired through a pluggable transport --
          set the matching environment variable on the server to switch one on.
        </p>
        <div class="col mt-2" style="gap:10px">
          ${channels.map(([key, label, available]) => `
            <div class="row-between" style="padding:9px 11px;background:var(--elev);border:1px solid var(--border);border-radius:10px">
              <div>
                <div class="small" style="font-weight:560">${esc(label)}</div>
                ${available ? '' : '<div class="tiny dim">Needs a transport configured on the server</div>'}
              </div>
              <label class="switch">
                <input type="checkbox" data-channel="${key}" ${prefs.channels?.[key] ? 'checked' : ''} ${available ? '' : 'disabled'}>
              </label>
            </div>`).join('')}
        </div>

        <div class="row-between mt-3">
          <span></span>
          <button class="btn btn-primary" data-act="save-notifications" data-busy-label="Saving">Save preferences</button>
        </div>
      </div>
    </div>`;
}

function dangerTab({ tournament, tournamentId }) {
  return `
    <div class="card mb-3">
      <div class="card-head"><h2>Tournament status</h2></div>
      <div class="card-body">
        <p class="muted small">Live tournaments are highlighted on the public site.</p>
        <div class="btn-group mt-1">
          ${['draft', 'live', 'completed', 'archived'].map((s) => `
            <button class="btn ${tournament.status === s ? 'active' : ''}" data-act="set-status" data-value="${s}">
              ${esc(s[0].toUpperCase() + s.slice(1))}</button>`).join('')}
        </div>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-head"><h2>Backup</h2></div>
      <div class="card-body">
        <p class="muted small">Download everything -- teams, fixtures, results, rankings and history.</p>
        <div class="row wrap gap-sm mt-1">
          <button class="btn" data-act="export" data-url="/api/tournaments/${tournamentId}/export/tournament.json">
            ${icon('download', 15)} Full backup (JSON)</button>
          <button class="btn" data-act="export" data-url="/api/tournaments/${tournamentId}/export/tournament.xlsx">
            ${icon('download', 15)} Everything (Excel)</button>
        </div>
      </div>
    </div>

    <div class="card" style="border-color:rgba(251,92,115,0.35)">
      <div class="card-head"><h2 style="color:var(--danger)">Danger zone</h2></div>
      <div class="card-body">
        <div class="row-between wrap" style="gap:12px">
          <div>
            <div style="font-weight:600">Delete this tournament</div>
            <div class="small muted">Removes every team, fixture, result and log entry. This cannot be undone.</div>
          </div>
          <button class="btn btn-danger" data-act="delete-tournament">${icon('trash', 15)} Delete tournament</button>
        </div>
      </div>
    </div>`;
}

// --------------------------------------------------------------- templates --
function templateList(templates) {
  if (!templates.length) {
    return emptyState({ icon: 'file', title: 'No templates', message: 'Save a tournament format to reuse it later.' });
  }
  return `
    <div class="grid grid-auto mt-2">
      ${templates.map((t) => `
        <div class="lobby">
          <div class="row-between">
            <h4 style="margin:0">${esc(t.name)}</h4>
            ${t.is_system ? '<span class="badge badge-info">Built-in</span>' : `
              <button class="btn btn-ghost btn-icon" data-act="delete-template" data-id="${t.id}"
                      data-name="${esc(t.name)}">${icon('trash', 13)}</button>`}
          </div>
          <div class="small muted mt-1">${esc(t.description || '')}</div>
          <div class="row wrap mt-2 tiny dim" style="gap:10px">
            <span>${esc(t.game)}</span>
            <span>${t.config?.tournament?.num_teams ?? '?'} teams</span>
            <span>${t.config?.tournament?.num_groups ?? 1} group(s)</span>
            <span>${esc(t.config?.tournament?.match_format || '')}</span>
          </div>
        </div>`).join('')}
    </div>`;
}

function saveTemplateDialog(data, ctx) {
  modal({
    title: 'Save as template',
    size: 'narrow',
    body: `
      <p class="muted small">Captures the format, scoring, tie-breakers and qualification rules -- but not the teams.</p>
      <form id="tpl-form" class="col mt-2" style="gap:12px">
        <div class="field">
          <label class="label" for="tpl-name">Template name</label>
          <input class="input" id="tpl-name" name="name" value="${esc(data.tournament.name)} Format" required>
        </div>
        <div class="field">
          <label class="label" for="tpl-desc">Description</label>
          <textarea class="textarea" id="tpl-desc" name="description" rows="2"
            placeholder="${esc(data.tournament.num_teams)} teams, ${esc(data.tournament.num_groups)} group(s)"></textarea>
        </div>
      </form>`,
    footer: `
      <button class="btn" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="save-tpl" data-busy-label="Saving">Save template</button>`,
    onMount(overlay, close) {
      overlay.querySelector('#save-tpl').addEventListener('click', async (e) => {
        const values = formData(overlay.querySelector('#tpl-form'));
        await withBusy(e.currentTarget, async () => {
          await api.post('/api/templates', {
            ...values,
            game: data.tournament.game,
            tournament_id: data.tournamentId,
          });
          toast('Template saved.', { type: 'success' });
          close();
          ctx.navigate(`/admin/t/${data.tournamentId}/settings?tab=templates`, { replace: true });
        });
      });
    },
  });
}

async function deleteTemplate(el, ctx, back) {
  const ok = await confirmAction({
    title: 'Delete template',
    message: `Delete the template "${el.dataset.name}"?`,
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  try {
    await api.delete(`/api/templates/${el.dataset.id}`);
    toast('Template deleted.', { type: 'success' });
    ctx.navigate(back, { replace: true });
  } catch (err) { toastError(err); }
}

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

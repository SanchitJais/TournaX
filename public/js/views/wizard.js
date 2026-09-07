/** Tournament setup wizard: template -> basics -> format -> scoring -> rules. */
import { api } from '../lib/api.js';
import { $, esc, formData, html, raw, readImage } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast, toastError, withBusy } from '../lib/ui.js';
import { invalidateTournament } from '../main.js';

const STEPS = ['Template', 'Basics', 'Format', 'Scoring', 'Qualification'];

export default {
  title: 'New tournament',

  async load(ctx) {
    if (!ctx.state.user) { ctx.navigate('/login', { replace: true }); return null; }
    const [meta, templates] = await Promise.all([api.get('/api/meta'), api.get('/api/templates')]);
    return { meta, templates: templates.templates };
  },

  render(data) {
    if (!data) return '';
    return html`
      <div class="page" style="max-width:940px">
        <div class="page-head">
          <div class="page-title">
            <h1>Create a tournament</h1>
            <p class="muted small" style="margin:0">Five short steps. Everything here can be changed later.</p>
          </div>
          <a class="btn btn-ghost" href="/admin">Cancel</a>
        </div>

        <div class="steps mb-3" id="stepper"></div>

        <form id="wizard" class="card">
          <div class="card-body" id="step-body"></div>
          <div class="modal-foot">
            <button type="button" class="btn" id="back">Back</button>
            <div class="grow"></div>
            <span class="small dim" id="step-hint"></span>
            <button type="button" class="btn btn-primary" id="next" data-busy-label="Creating">Continue</button>
          </div>
        </form>
      </div>`;
  },

  mounted(data, ctx, root) {
    const { meta, templates } = data;
    const model = {
      step: 0,
      template_id: '',
      name: '', game: 'BGMI', description: '', prize_pool: '',
      logo_url: null, banner_url: null,
      start_date: '', end_date: '',
      format_type: 'battle_royale', match_format: 'Squad (TPP)',
      num_teams: 16, num_groups: 1, num_rounds: 1, matches_per_round: 6, teams_per_match: 16,
      scoring: structuredClone(meta.defaults.scoring),
      tiebreakers: [...meta.defaults.tiebreakers],
      qualification: structuredClone(meta.defaults.qualification),
      fixture_options: structuredClone(meta.defaults.fixture_options),
      schedule_options: structuredClone(meta.defaults.schedule_options),
    };

    const stepper = $('#stepper', root);
    const body = $('#step-body', root);
    const backBtn = $('#back', root);
    const nextBtn = $('#next', root);
    const hint = $('#step-hint', root);

    const draw = () => {
      stepper.innerHTML = STEPS.map((label, i) => `
        <div class="step ${i < model.step ? 'done' : ''} ${i === model.step ? 'current' : ''}">
          <span class="step-n">${i < model.step ? '✓' : i + 1}</span>${esc(label)}
        </div>`).join('');

      body.innerHTML = [stepTemplate, stepBasics, stepFormat, stepScoring, stepQualification][model.step](model, meta, templates);
      backBtn.style.visibility = model.step === 0 ? 'hidden' : 'visible';
      nextBtn.textContent = model.step === STEPS.length - 1 ? 'Create tournament' : 'Continue';
      hint.textContent = model.step === STEPS.length - 1 ? '' : `Step ${model.step + 1} of ${STEPS.length}`;
      wireStep();
    };

    /** Copy the current step's inputs into the model. */
    const capture = () => {
      const values = formData(root.querySelector('#wizard'));
      if (model.step === 1) {
        Object.assign(model, {
          name: values.name?.trim() || '',
          game: values.game || 'BGMI',
          description: values.description || '',
          prize_pool: values.prize_pool || '',
          start_date: values.start_date || '',
          end_date: values.end_date || '',
        });
      }
      if (model.step === 2) {
        Object.assign(model, {
          format_type: values.format_type,
          match_format: values.match_format,
          num_teams: values.num_teams || 16,
          num_groups: values.num_groups || 1,
          num_rounds: values.num_rounds || 1,
          matches_per_round: values.matches_per_round || 1,
          teams_per_match: values.teams_per_match || 16,
        });
        model.fixture_options.mode = values.fixture_mode || 'rotating';
        model.fixture_options.seeded = Boolean(values.seeded);
        model.schedule_options.firstMatchTime = values.firstMatchTime || '19:00';
        model.schedule_options.matchGapMinutes = values.matchGapMinutes || 60;
        model.schedule_options.matchesPerDay = values.matchesPerDay || 4;
      }
      if (model.step === 3) {
        model.scoring.killPoints = values.killPoints ?? 1;
        model.scoring.winBonus = values.winBonus ?? 0;
        model.scoring.defaultPlacementPoints = values.defaultPlacementPoints ?? 0;
        const table = {};
        root.querySelectorAll('[data-place]').forEach((input) => {
          const value = Number(input.value);
          if (Number.isFinite(value)) table[input.dataset.place] = value;
        });
        if (Object.keys(table).length) model.scoring.placementPoints = table;
        model.tiebreakers = [...root.querySelectorAll('[data-tb]:checked')].map((el) => el.dataset.tb);
      }
      if (model.step === 4) {
        model.qualification.mode = values.qual_mode || 'top_overall';
        model.qualification.count = values.qual_count ?? 8;
        model.qualification.perGroup = values.qual_per_group ?? 3;
      }
    };

    const validate = () => {
      if (model.step === 1 && !model.name.trim()) {
        toast('Give the tournament a name to continue.', { type: 'error' });
        root.querySelector('[name=name]')?.focus();
        return false;
      }
      return true;
    };

    const wireStep = () => {
      // Template cards.
      body.querySelectorAll('[data-template]').forEach((card) => {
        card.addEventListener('click', () => {
          const id = card.dataset.template;
          model.template_id = model.template_id === id ? '' : id;
          if (model.template_id) applyTemplate(model, templates.find((t) => String(t.id) === id));
          draw();
        });
      });

      // Image pickers.
      body.querySelectorAll('input[type=file][data-image]').forEach((input) => {
        input.addEventListener('change', async () => {
          try {
            const dataUrl = await readImage(input);
            model[input.dataset.image] = dataUrl;
            const preview = body.querySelector(`[data-preview="${input.dataset.image}"]`);
            if (preview && dataUrl) {
              preview.innerHTML = `<img src="${dataUrl}" alt="" style="width:100%;height:100%;object-fit:cover">`;
            }
          } catch (err) { toastError(err); }
        });
      });

      // Format type changes which controls are relevant.
      body.querySelector('[name=format_type]')?.addEventListener('change', () => { capture(); draw(); });
      body.querySelector('[name=qual_mode]')?.addEventListener('change', () => { capture(); draw(); });
      body.querySelector('[name=num_teams]')?.addEventListener('input', (e) => {
        const teamsField = body.querySelector('[name=teams_per_match]');
        if (teamsField && !teamsField.dataset.touched) teamsField.value = Math.min(Number(e.target.value) || 16, 16);
      });
      body.querySelector('[name=teams_per_match]')?.addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
    };

    backBtn.addEventListener('click', () => {
      capture();
      model.step = Math.max(0, model.step - 1);
      draw();
    });

    nextBtn.addEventListener('click', async () => {
      capture();
      if (!validate()) return;
      if (model.step < STEPS.length - 1) {
        model.step++;
        draw();
        return;
      }
      await withBusy(nextBtn, async () => {
        const payload = {
          name: model.name, game: model.game, description: model.description,
          prize_pool: model.prize_pool, logo_url: model.logo_url, banner_url: model.banner_url,
          start_date: model.start_date || null, end_date: model.end_date || null,
          format_type: model.format_type, match_format: model.match_format,
          num_teams: model.num_teams, num_groups: model.num_groups, num_rounds: model.num_rounds,
          matches_per_round: model.matches_per_round, teams_per_match: model.teams_per_match,
          settings: {
            scoring: model.scoring,
            tiebreakers: model.tiebreakers,
            qualification: model.qualification,
            fixture_options: model.fixture_options,
            schedule_options: model.schedule_options,
          },
        };
        const res = await api.post('/api/tournaments', payload);
        invalidateTournament();
        toast('Tournament created. Add your teams next.', { type: 'success' });
        ctx.navigate(`/admin/t/${res.tournament.id}/teams`);
      });
    });

    draw();
  },
};

function applyTemplate(model, template) {
  if (!template) return;
  Object.assign(model, template.config.tournament || {});
  const settings = template.config.settings || {};
  if (settings.scoring) model.scoring = { ...model.scoring, ...settings.scoring };
  if (settings.tiebreakers) model.tiebreakers = [...settings.tiebreakers];
  if (settings.qualification) model.qualification = { ...model.qualification, ...settings.qualification };
  if (settings.fixture_options) model.fixture_options = { ...model.fixture_options, ...settings.fixture_options };
  if (settings.schedule_options) model.schedule_options = { ...model.schedule_options, ...settings.schedule_options };
  if (template.game) model.game = template.game;
}

// ------------------------------------------------------------------- steps --
const stepTemplate = (model, meta, templates) => html`
  <h2 class="mb-1">Start from a template</h2>
  <p class="muted small">Templates prefill the format, scoring and qualification rules. Pick one, or start from scratch.</p>
  <div class="grid grid-auto mt-2">
    <div class="lobby" data-template="" style="cursor:pointer;${!model.template_id ? 'border-color:var(--primary);background:var(--primary-dim)' : ''}">
      <h4>Blank</h4>
      <div class="small muted">Start from scratch with the standard BGMI defaults.</div>
    </div>
    ${raw(templates.map((t) => `
      <div class="lobby" data-template="${t.id}" style="cursor:pointer;${String(model.template_id) === String(t.id) ? 'border-color:var(--primary);background:var(--primary-dim)' : ''}">
        <h4>${esc(t.name)}</h4>
        <div class="small muted">${esc(t.description || '')}</div>
        <div class="row mt-2 tiny dim" style="gap:10px">
          <span>${esc(t.game)}</span>
          <span>${t.config?.tournament?.num_teams || '?'} teams</span>
        </div>
      </div>`).join(''))}
  </div>`;

const stepBasics = (model) => html`
  <h2 class="mb-2">Tournament details</h2>
  <div class="grid grid-2">
    <div class="field">
      <label class="label" for="w-name">Tournament name *</label>
      <input class="input" id="w-name" name="name" value="${model.name}" placeholder="BGMI Pro Series 2026" required>
    </div>
    <div class="field">
      <label class="label" for="w-game">Game</label>
      <input class="input" id="w-game" name="game" value="${model.game}" placeholder="BGMI" list="games">
      <datalist id="games">
        <option>BGMI</option><option>PUBG Mobile</option><option>Valorant</option>
        <option>Free Fire</option><option>CS2</option><option>Call of Duty Mobile</option>
      </datalist>
    </div>
    <div class="field">
      <label class="label" for="w-start">Start date</label>
      <input class="input" id="w-start" name="start_date" type="date" value="${model.start_date || ''}">
    </div>
    <div class="field">
      <label class="label" for="w-end">End date</label>
      <input class="input" id="w-end" name="end_date" type="date" value="${model.end_date || ''}">
    </div>
    <div class="field">
      <label class="label" for="w-prize">Prize pool</label>
      <input class="input" id="w-prize" name="prize_pool" value="${model.prize_pool}" placeholder="Rs 25,00,000">
    </div>
    <div class="field">
      <label class="label">Branding</label>
      <div class="row" style="gap:10px">
        <label class="team-logo lg" data-preview="logo_url" style="cursor:pointer" title="Upload logo">
          ${model.logo_url ? raw(`<img src="${model.logo_url}" alt="" style="width:100%;height:100%;object-fit:cover">`) : raw(icon('plus', 15))}
          <input type="file" accept="image/*" data-image="logo_url" hidden>
        </label>
        <label class="btn btn-sm" style="cursor:pointer">
          ${raw(icon('upload', 14))} Banner
          <input type="file" accept="image/*" data-image="banner_url" hidden>
        </label>
        <span class="team-logo" data-preview="banner_url" style="width:64px;border-radius:8px">
          ${model.banner_url ? raw(`<img src="${model.banner_url}" alt="" style="width:100%;height:100%;object-fit:cover">`) : ''}
        </span>
      </div>
      <span class="hint">Logo and banner appear on the public page.</span>
    </div>
  </div>
  <div class="field mt-2">
    <label class="label" for="w-desc">Description</label>
    <textarea class="textarea" id="w-desc" name="description" placeholder="Format, rules, broadcast links...">${model.description}</textarea>
  </div>`;

const stepFormat = (model, meta) => {
  const isBr = model.format_type === 'battle_royale';
  const isBracket = model.format_type === 'single_elimination';
  const lobbies = Math.max(1, Math.ceil((model.num_teams || 1) / (model.teams_per_match || 1)));
  const totalMatches = isBracket
    ? Math.ceil((model.num_teams || 2) / 2)
    : (model.num_rounds || 1) * (model.matches_per_round || 1);

  return html`
    <h2 class="mb-2">Format &amp; schedule</h2>
    <div class="grid grid-2">
      <div class="field">
        <label class="label" for="w-format">Tournament type</label>
        <select class="select" id="w-format" name="format_type">
          ${raw(Object.entries(meta.formats).map(([value, label]) =>
            `<option value="${value}" ${model.format_type === value ? 'selected' : ''}>${esc(label)}</option>`).join(''))}
        </select>
      </div>
      <div class="field">
        <label class="label" for="w-mf">Match format</label>
        <input class="input" id="w-mf" name="match_format" value="${model.match_format}" list="mformats">
        <datalist id="mformats">
          <option>Squad (TPP)</option><option>Squad (FPP)</option><option>Duo</option>
          <option>Solo</option><option>Best of 1</option><option>Best of 3</option><option>Best of 5</option>
        </datalist>
      </div>
      <div class="field">
        <label class="label" for="w-teams">Number of teams</label>
        <input class="input" id="w-teams" name="num_teams" type="number" min="2" max="512" value="${model.num_teams}">
      </div>
      <div class="field">
        <label class="label" for="w-tpm">Teams per match</label>
        <input class="input" id="w-tpm" name="teams_per_match" type="number" min="2" max="128" value="${model.teams_per_match}">
        <span class="hint">${isBracket ? 'Two for a knockout bracket.' : `Lobby size. Gives ${lobbies} lobby/lobbies.`}</span>
      </div>
      ${isBracket ? '' : raw(`
        <div class="field">
          <label class="label" for="w-groups">Number of groups</label>
          <input class="input" id="w-groups" name="num_groups" type="number" min="1" max="32" value="${model.num_groups}">
        </div>
        <div class="field">
          <label class="label" for="w-rounds">Number of rounds</label>
          <input class="input" id="w-rounds" name="num_rounds" type="number" min="1" max="60" value="${model.num_rounds}">
        </div>
        <div class="field">
          <label class="label" for="w-mpr">Matches per round</label>
          <input class="input" id="w-mpr" name="matches_per_round" type="number" min="1" max="60" value="${model.matches_per_round}">
          <span class="hint">Total matches across all lobbies in one round.</span>
        </div>`)}
      <div class="field">
        <label class="label" for="w-first">First match time</label>
        <input class="input" id="w-first" name="firstMatchTime" type="time" value="${model.schedule_options.firstMatchTime}">
      </div>
      <div class="field">
        <label class="label" for="w-gap">Minutes between matches</label>
        <input class="input" id="w-gap" name="matchGapMinutes" type="number" min="5" max="600" value="${model.schedule_options.matchGapMinutes}">
      </div>
      <div class="field">
        <label class="label" for="w-perday">Matches per day</label>
        <input class="input" id="w-perday" name="matchesPerDay" type="number" min="1" max="30" value="${model.schedule_options.matchesPerDay}">
      </div>
    </div>

    ${isBr ? raw(`
      <div class="divider"></div>
      <h3 class="mb-1">Lobby assignment</h3>
      <div class="grid grid-2">
        <label class="chip ${model.fixture_options.mode === 'rotating' ? 'active' : ''}" style="padding:12px;align-items:flex-start;gap:10px">
          <input type="radio" name="fixture_mode" value="rotating" ${model.fixture_options.mode === 'rotating' ? 'checked' : ''} style="margin-top:3px">
          <span><b>Rotating lobbies</b><br><span class="small muted">Teams are redrawn each round so they face as many different opponents as possible.</span></span>
        </label>
        <label class="chip ${model.fixture_options.mode === 'static' ? 'active' : ''}" style="padding:12px;align-items:flex-start;gap:10px">
          <input type="radio" name="fixture_mode" value="static" ${model.fixture_options.mode === 'static' ? 'checked' : ''} style="margin-top:3px">
          <span><b>Fixed groups</b><br><span class="small muted">Each group stays together and plays its own matches every round.</span></span>
        </label>
      </div>`) : ''}

    <label class="check mt-2">
      <input type="checkbox" name="seeded" ${model.fixture_options.seeded ? 'checked' : ''}>
      Use team seeds when drawing (otherwise the draw is random)
    </label>

    <div class="info-box mt-3">
      ${raw(icon('info', 15))}
      <div>This produces about <b>${totalMatches}</b> match(es)${isBracket ? ' in the opening round' : ''}. You can regenerate the schedule any time.</div>
    </div>`;
};

const stepScoring = (model, meta) => {
  const places = Object.keys(model.scoring.placementPoints)
    .map(Number).sort((a, b) => a - b);

  return html`
    <h2 class="mb-1">Scoring system</h2>
    <p class="muted small">Points are calculated automatically from placements and kills. You never add them up by hand.</p>

    <div class="grid grid-3 mt-2">
      <div class="field">
        <label class="label" for="w-kp">Points per kill</label>
        <input class="input" id="w-kp" name="killPoints" type="number" step="0.5" value="${model.scoring.killPoints}">
      </div>
      <div class="field">
        <label class="label" for="w-wb">Bonus for a win</label>
        <input class="input" id="w-wb" name="winBonus" type="number" step="0.5" value="${model.scoring.winBonus}">
      </div>
      <div class="field">
        <label class="label" for="w-dp">Points below the table</label>
        <input class="input" id="w-dp" name="defaultPlacementPoints" type="number" step="0.5" value="${model.scoring.defaultPlacementPoints}">
      </div>
    </div>

    <div class="divider"></div>
    <h3 class="mb-1">Placement points</h3>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px">
      ${raw(places.map((place) => `
        <div class="field">
          <label class="label" for="place-${place}">${ordinal(place)}</label>
          <input class="input input-sm num" id="place-${place}" data-place="${place}" type="number" step="0.5"
                 value="${model.scoring.placementPoints[place]}">
        </div>`).join(''))}
    </div>

    <div class="divider"></div>
    <h3 class="mb-1">Tie-breakers</h3>
    <p class="muted small">Applied in order until two teams are separated. Total points always applies first.</p>
    <div class="grid grid-2 mt-2">
      ${raw(Object.entries(meta.tiebreakers).map(([key, label]) => `
        <label class="check">
          <input type="checkbox" data-tb="${key}" ${model.tiebreakers.includes(key) ? 'checked' : ''}>
          ${esc(label)}
        </label>`).join(''))}
    </div>`;
};

const stepQualification = (model) => html`
  <h2 class="mb-1">Qualification</h2>
  <p class="muted small">Who advances out of the group stage. The cut updates live as results come in.</p>

  <div class="field mt-2" style="max-width:340px">
    <label class="label" for="w-qmode">Rule</label>
    <select class="select" id="w-qmode" name="qual_mode">
      <option value="top_overall" ${model.qualification.mode === 'top_overall' ? 'selected' : ''}>Top X teams overall</option>
      <option value="top_per_group" ${model.qualification.mode === 'top_per_group' ? 'selected' : ''}>Top X from each group</option>
      <option value="all" ${model.qualification.mode === 'all' ? 'selected' : ''}>Everyone advances</option>
      <option value="custom" ${model.qualification.mode === 'custom' ? 'selected' : ''}>Hand-picked teams</option>
    </select>
  </div>

  ${model.qualification.mode === 'top_overall' ? raw(`
    <div class="field mt-2" style="max-width:220px">
      <label class="label" for="w-qcount">How many qualify</label>
      <input class="input" id="w-qcount" name="qual_count" type="number" min="1" max="512" value="${model.qualification.count}">
    </div>`) : ''}

  ${model.qualification.mode === 'top_per_group' ? raw(`
    <div class="field mt-2" style="max-width:220px">
      <label class="label" for="w-qper">From each group</label>
      <input class="input" id="w-qper" name="qual_per_group" type="number" min="1" max="64" value="${model.qualification.perGroup}">
    </div>`) : ''}

  ${model.qualification.mode === 'custom' ? raw(`
    <div class="info-box mt-2">${icon('info', 15)}<div>Pick the qualifying teams on the Qualification page once results are in.</div></div>`) : ''}

  <div class="divider"></div>
  <div class="info-box">
    ${raw(icon('zap', 15))}
    <div>
      <b>What happens next:</b> add or import your teams, press <b>Generate Fixtures</b>,
      and enter results. Rankings, qualification and the next round are all worked out for you.
    </div>
  </div>`;

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/** Tournament CRUD, the setup wizard, settings, stages and templates. */
import { all, get, insert, parseJson, run, toJson, tx, updateRow } from '../db.js';
import { can, requireAbility, requireUser } from '../auth.js';
import {
  DEFAULT_SETTINGS, FORMAT_TYPES, MAPS, NOTIFICATION_EVENTS, STAGE_KINDS, STAGE_LABELS,
  TIEBREAKER_KEYS,
} from '../config.js';
import { badRequest, conflict, notFound, saveDataUrl } from '../lib/http.js';
import { recordAudit } from '../services/audit.js';
import { currentStage, generateNextStage, nextStageKind } from '../services/progression.js';
import { tournamentStats } from '../services/leaderboard.js';

const TOURNAMENT_FIELDS = [
  'name', 'game', 'format_type', 'match_format', 'description', 'banner_url', 'logo_url',
  'num_teams', 'num_groups', 'num_rounds', 'matches_per_round', 'teams_per_match',
  'start_date', 'end_date', 'timezone', 'prize_pool', 'status', 'is_public',
];

export function slugify(name, suffix = '') {
  const base = String(name || 'tournament')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'tournament';
  return suffix ? `${base}-${suffix}` : base;
}

function uniqueSlug(name) {
  let slug = slugify(name);
  let n = 1;
  while (get('SELECT id FROM tournaments WHERE slug = ?', [slug])) slug = slugify(name, ++n);
  return slug;
}

export function loadTournament(id) {
  const tournament = get('SELECT * FROM tournaments WHERE id = ?', [id]);
  if (!tournament) throw notFound('Tournament not found');
  return tournament;
}

export function loadSettings(tournamentId) {
  const row = get('SELECT * FROM tournament_settings WHERE tournament_id = ?', [tournamentId]);
  if (row) return row;
  const defaults = DEFAULT_SETTINGS();
  writeSettings(tournamentId, defaults);
  return get('SELECT * FROM tournament_settings WHERE tournament_id = ?', [tournamentId]);
}

function writeSettings(tournamentId, settings) {
  run(
    `INSERT INTO tournament_settings
       (tournament_id, scoring, tiebreakers, qualification, fixture_options, schedule_options, notification_prefs, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(tournament_id) DO UPDATE SET
       scoring = excluded.scoring, tiebreakers = excluded.tiebreakers,
       qualification = excluded.qualification, fixture_options = excluded.fixture_options,
       schedule_options = excluded.schedule_options, notification_prefs = excluded.notification_prefs,
       updated_at = datetime('now')`,
    [
      tournamentId, toJson(settings.scoring), toJson(settings.tiebreakers),
      toJson(settings.qualification), toJson(settings.fixture_options),
      toJson(settings.schedule_options), toJson(settings.notification_prefs),
    ],
  );
}

export const expandSettings = (row) => ({
  scoring: parseJson(row.scoring, {}),
  tiebreakers: parseJson(row.tiebreakers, []),
  qualification: parseJson(row.qualification, {}),
  fixture_options: parseJson(row.fixture_options, {}),
  schedule_options: parseJson(row.schedule_options, {}),
  notification_prefs: parseJson(row.notification_prefs, {}),
});

export default function register(router) {
  /** Vocabularies the wizard needs to render its selects. */
  router.get('/api/meta', () => ({
    formats: FORMAT_TYPES,
    stageKinds: STAGE_KINDS.map((k) => ({ value: k, label: STAGE_LABELS[k] })),
    tiebreakers: TIEBREAKER_KEYS,
    notificationEvents: NOTIFICATION_EVENTS,
    maps: MAPS,
    defaults: DEFAULT_SETTINGS(),
  }));

  router.get('/api/tournaments', (ctx) => {
    requireUser(ctx);
    const mine = ctx.user.role === 'super_admin'
      ? all('SELECT * FROM tournaments ORDER BY created_at DESC')
      : all(
        `SELECT DISTINCT t.* FROM tournaments t
           LEFT JOIN tournament_members m ON m.tournament_id = t.id AND m.user_id = ?
          WHERE t.owner_id = ? OR m.id IS NOT NULL
          ORDER BY t.created_at DESC`,
        [ctx.user.id, ctx.user.id],
      );

    return {
      tournaments: mine.map((t) => ({
        ...t,
        counts: {
          teams: get('SELECT COUNT(*) AS n FROM teams WHERE tournament_id = ?', [t.id]).n,
          matches: get('SELECT COUNT(*) AS n FROM matches WHERE tournament_id = ?', [t.id]).n,
          completed: get("SELECT COUNT(*) AS n FROM matches WHERE tournament_id = ? AND status = 'completed'", [t.id]).n,
        },
      })),
    };
  });

  /** Create -- optionally seeded from a template. */
  router.post('/api/tournaments', (ctx) => {
    const user = requireUser(ctx);
    if (!can(ctx.user, 'tournament:write') && ctx.user.role !== 'tournament_admin' && ctx.user.role !== 'super_admin') {
      throw badRequest('Your role cannot create tournaments.');
    }
    const body = { ...ctx.body };

    let settings = DEFAULT_SETTINGS();
    if (body.template_id) {
      const template = get('SELECT * FROM templates WHERE id = ?', [Number(body.template_id)]);
      if (!template) throw notFound('Template not found');
      const config = parseJson(template.config, {});
      Object.assign(body, { ...config.tournament, ...stripEmpty(body) });
      settings = mergeSettings(settings, config.settings || {});
    }
    settings = mergeSettings(settings, body.settings || {});

    const name = String(body.name || '').trim();
    if (!name) throw badRequest('Give the tournament a name.');

    const id = tx(() => {
      const tournamentId = insert(
        `INSERT INTO tournaments
           (slug, name, game, format_type, match_format, description, banner_url, logo_url,
            num_teams, num_groups, num_rounds, matches_per_round, teams_per_match,
            start_date, end_date, timezone, prize_pool, status, is_public, owner_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          uniqueSlug(name), name, body.game || 'BGMI', body.format_type || 'battle_royale',
          body.match_format || 'Squad (TPP)', body.description || null,
          saveDataUrl(body.banner_url, 'banner'), saveDataUrl(body.logo_url, 'logo'),
          int(body.num_teams, 16), int(body.num_groups, 1), int(body.num_rounds, 1),
          int(body.matches_per_round, 4), int(body.teams_per_match, 16),
          body.start_date || null, body.end_date || null, body.timezone || 'Asia/Kolkata',
          body.prize_pool || null, body.status || 'draft', body.is_public === false ? 0 : 1,
          user.id,
        ],
      );
      writeSettings(tournamentId, settings);
      insert(
        `INSERT INTO stages (tournament_id, name, kind, order_index, status, num_groups, num_rounds, matches_per_round, teams_per_match)
         VALUES (?, ?, 'group_stage', 0, 'pending', ?, ?, ?, ?)`,
        [
          tournamentId, body.stage_name || 'Group Stage',
          int(body.num_groups, 1), int(body.num_rounds, 1),
          int(body.matches_per_round, 4), int(body.teams_per_match, 16),
        ],
      );
      return tournamentId;
    });

    recordAudit({
      tournamentId: id, actor: user, action: 'tournament.created', entity: 'tournament', entityId: id,
      summary: `Created tournament "${name}".`,
    });
    return { __status: 201, tournament: loadTournament(id) };
  });

  /** Everything the admin shell needs for one tournament, in one round trip. */
  router.get('/api/tournaments/:id', (ctx) => {
    const id = Number(ctx.params.id);
    const tournament = loadTournament(id);
    requireUser(ctx);
    if (!can(ctx.user, 'export', id) && !can(ctx.user, 'tournament:write', id) && tournament.owner_id !== ctx.user.id) {
      // Spectators may still read a public tournament through /api/public.
      if (!tournament.is_public) throw notFound('Tournament not found');
    }
    const settingsRow = loadSettings(id);
    return {
      tournament,
      settings: expandSettings(settingsRow),
      stages: listStages(id),
      groups: all('SELECT * FROM groups WHERE tournament_id = ? ORDER BY order_index, name', [id]),
      current_stage: currentStage(id),
      stats: tournamentStats(id, parseJson(settingsRow.tiebreakers, [])),
    };
  });

  router.patch('/api/tournaments/:id', (ctx) => {
    const id = Number(ctx.params.id);
    requireAbility(ctx, 'tournament:write', id);
    const before = loadTournament(id);

    const fields = { ...ctx.body };
    if (fields.banner_url) fields.banner_url = saveDataUrl(fields.banner_url, 'banner');
    if (fields.logo_url) fields.logo_url = saveDataUrl(fields.logo_url, 'logo');
    if (fields.is_public !== undefined) fields.is_public = fields.is_public ? 1 : 0;
    if (fields.name && fields.name !== before.name && !ctx.body.keep_slug) {
      fields.slug = uniqueSlug(fields.name);
    }
    updateRow('tournaments', id, fields, [...TOURNAMENT_FIELDS, 'slug']);

    if (ctx.body.settings) {
      writeSettings(id, mergeSettings(expandSettings(loadSettings(id)), ctx.body.settings));
    }

    const after = loadTournament(id);
    recordAudit({
      tournamentId: id, actor: ctx.user, action: 'tournament.updated', entity: 'tournament', entityId: id,
      summary: describeChanges(before, after) || 'Updated tournament settings.',
      before, after,
    });
    return { tournament: after, settings: expandSettings(loadSettings(id)) };
  });

  router.patch('/api/tournaments/:id/settings', (ctx) => {
    const id = Number(ctx.params.id);
    requireAbility(ctx, 'tournament:write', id);
    const merged = mergeSettings(expandSettings(loadSettings(id)), ctx.body || {});
    writeSettings(id, merged);
    recordAudit({
      tournamentId: id, actor: ctx.user, action: 'settings.updated', entity: 'tournament', entityId: id,
      summary: 'Updated scoring, tiebreak or qualification rules.', after: merged,
    });
    return { settings: merged };
  });

  router.delete('/api/tournaments/:id', (ctx) => {
    const id = Number(ctx.params.id);
    requireAbility(ctx, 'tournament:write', id);
    const tournament = loadTournament(id);
    run('DELETE FROM tournaments WHERE id = ?', [id]);
    recordAudit({ actor: ctx.user, action: 'tournament.deleted', entity: 'tournament', entityId: id, summary: `Deleted "${tournament.name}".` });
    return { ok: true };
  });

  // ------------------------------------------------------------------ stages --
  router.get('/api/tournaments/:id/stages', (ctx) => ({ stages: listStages(Number(ctx.params.id)) }));

  router.post('/api/tournaments/:id/stages', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'stages:write', tournamentId);
    const tournament = loadTournament(tournamentId);
    const orderIndex = (get('SELECT MAX(order_index) AS m FROM stages WHERE tournament_id = ?', [tournamentId]).m ?? -1) + 1;
    const kind = STAGE_KINDS.includes(ctx.body.kind) ? ctx.body.kind : 'custom';
    const id = insert(
      `INSERT INTO stages (tournament_id, name, kind, order_index, status, num_groups, num_rounds, matches_per_round, teams_per_match, source_stage_id)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [
        tournamentId, ctx.body.name || STAGE_LABELS[kind] || `Stage ${orderIndex + 1}`, kind, orderIndex,
        int(ctx.body.num_groups, tournament.num_groups), int(ctx.body.num_rounds, 1),
        int(ctx.body.matches_per_round, tournament.matches_per_round),
        int(ctx.body.teams_per_match, tournament.teams_per_match),
        ctx.body.source_stage_id ? Number(ctx.body.source_stage_id) : null,
      ],
    );
    recordAudit({ tournamentId, actor: ctx.user, action: 'stage.created', entity: 'stage', entityId: id, summary: `Added stage "${ctx.body.name || kind}".` });
    return { __status: 201, stage: get('SELECT * FROM stages WHERE id = ?', [id]) };
  });

  router.patch('/api/stages/:id', (ctx) => {
    const stage = get('SELECT * FROM stages WHERE id = ?', [Number(ctx.params.id)]);
    if (!stage) throw notFound('Stage not found');
    requireAbility(ctx, 'stages:write', stage.tournament_id);
    const fields = { ...ctx.body };
    if (fields.qualification) fields.qualification = toJson(fields.qualification);
    updateRow('stages', stage.id, fields, [
      'name', 'kind', 'status', 'num_groups', 'num_rounds', 'matches_per_round',
      'teams_per_match', 'qualification', 'order_index', 'source_stage_id',
    ]);
    return { stage: get('SELECT * FROM stages WHERE id = ?', [stage.id]) };
  });

  router.delete('/api/stages/:id', (ctx) => {
    const stage = get('SELECT * FROM stages WHERE id = ?', [Number(ctx.params.id)]);
    if (!stage) throw notFound('Stage not found');
    requireAbility(ctx, 'stages:write', stage.tournament_id);
    const remaining = get('SELECT COUNT(*) AS n FROM stages WHERE tournament_id = ?', [stage.tournament_id]).n;
    if (remaining <= 1) throw badRequest('A tournament needs at least one stage.');
    run('DELETE FROM stages WHERE id = ?', [stage.id]);
    recordAudit({ tournamentId: stage.tournament_id, actor: ctx.user, action: 'stage.deleted', entity: 'stage', entityId: stage.id, summary: `Deleted stage "${stage.name}".` });
    return { ok: true };
  });

  /** "Generate Next Round" -- carries qualified teams into a new stage. */
  router.post('/api/stages/:id/next', (ctx) => {
    const fromStage = get('SELECT * FROM stages WHERE id = ?', [Number(ctx.params.id)]);
    if (!fromStage) throw notFound('Stage not found');
    requireAbility(ctx, 'stages:write', fromStage.tournament_id);

    const tournament = loadTournament(fromStage.tournament_id);
    const result = generateNextStage({
      tournament,
      settings: loadSettings(tournament.id),
      fromStage,
      config: ctx.body || {},
      actor: ctx.user,
    });
    return {
      stage: result.stage,
      matches: result.matches,
      warnings: result.warnings,
      teams: result.teams.map((t) => ({ id: t.id, name: t.name, seed: t.seed })),
    };
  });

  /** What the next stage would look like, without creating it. */
  router.get('/api/stages/:id/next/preview', (ctx) => {
    const stage = get('SELECT * FROM stages WHERE id = ?', [Number(ctx.params.id)]);
    if (!stage) throw notFound('Stage not found');
    const tournament = loadTournament(stage.tournament_id);
    const qualified = all(
      `SELECT t.id, t.name, q.rank FROM qualifications q JOIN teams t ON t.id = q.team_id
        WHERE q.stage_id = ? AND q.status = 'qualified' ORDER BY q.rank`,
      [stage.id],
    );
    return {
      qualified,
      suggested_kind: nextStageKind(tournament.format_type, qualified.length, stage.kind),
      locked: qualified.length > 0,
    };
  });

  // --------------------------------------------------------------- templates --
  router.get('/api/templates', () => ({
    templates: all('SELECT * FROM templates ORDER BY is_system DESC, name')
      .map((t) => ({ ...t, config: parseJson(t.config, {}) })),
  }));

  router.post('/api/templates', (ctx) => {
    requireUser(ctx);
    let config = ctx.body.config;
    // Saving an existing tournament as a reusable format.
    if (ctx.body.tournament_id) {
      const tournamentId = Number(ctx.body.tournament_id);
      requireAbility(ctx, 'templates:write', tournamentId);
      const t = loadTournament(tournamentId);
      config = {
        tournament: {
          format_type: t.format_type, match_format: t.match_format, game: t.game,
          num_teams: t.num_teams, num_groups: t.num_groups, num_rounds: t.num_rounds,
          matches_per_round: t.matches_per_round, teams_per_match: t.teams_per_match,
        },
        settings: expandSettings(loadSettings(tournamentId)),
      };
    }
    if (!config) throw badRequest('Nothing to save as a template.');
    const name = String(ctx.body.name || '').trim();
    if (!name) throw badRequest('Give the template a name.');
    if (get('SELECT id FROM templates WHERE name = ?', [name])) throw conflict('A template with that name already exists.');

    const id = insert(
      'INSERT INTO templates (name, game, description, config, is_system, owner_id) VALUES (?, ?, ?, ?, 0, ?)',
      [name, ctx.body.game || 'BGMI', ctx.body.description || null, toJson(config), ctx.user.id],
    );
    return { __status: 201, template: { ...get('SELECT * FROM templates WHERE id = ?', [id]), config } };
  });

  router.delete('/api/templates/:id', (ctx) => {
    requireUser(ctx);
    const template = get('SELECT * FROM templates WHERE id = ?', [Number(ctx.params.id)]);
    if (!template) throw notFound('Template not found');
    if (template.is_system && ctx.user.role !== 'super_admin') throw badRequest('Built-in templates cannot be deleted.');
    if (!template.is_system && template.owner_id !== ctx.user.id && ctx.user.role !== 'super_admin') {
      throw badRequest('You can only delete templates you created.');
    }
    run('DELETE FROM templates WHERE id = ?', [template.id]);
    return { ok: true };
  });
}

function listStages(tournamentId) {
  return all('SELECT * FROM stages WHERE tournament_id = ? ORDER BY order_index', [tournamentId]).map((s) => ({
    ...s,
    qualification: parseJson(s.qualification, null),
    match_count: get('SELECT COUNT(*) AS n FROM matches WHERE stage_id = ?', [s.id]).n,
    completed_count: get("SELECT COUNT(*) AS n FROM matches WHERE stage_id = ? AND status = 'completed'", [s.id]).n,
    qualified_count: get("SELECT COUNT(*) AS n FROM qualifications WHERE stage_id = ? AND status = 'qualified'", [s.id]).n,
  }));
}

const int = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
};

const stripEmpty = (obj) => Object.fromEntries(
  Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''),
);

/** Deep-merges one level of each settings section. */
export function mergeSettings(base, incoming) {
  const out = { ...base };
  for (const key of ['scoring', 'qualification', 'fixture_options', 'schedule_options']) {
    if (incoming[key]) out[key] = { ...base[key], ...incoming[key] };
  }
  if (incoming.notification_prefs) {
    out.notification_prefs = {
      events: { ...base.notification_prefs?.events, ...incoming.notification_prefs.events },
      channels: { ...base.notification_prefs?.channels, ...incoming.notification_prefs.channels },
    };
  }
  if (Array.isArray(incoming.tiebreakers)) out.tiebreakers = incoming.tiebreakers.filter((k) => TIEBREAKER_KEYS[k]);
  return out;
}

function describeChanges(before, after) {
  const changed = TOURNAMENT_FIELDS.filter((f) => before[f] !== after[f] && after[f] !== undefined);
  if (!changed.length) return null;
  return `Changed ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ` +${changed.length - 6} more` : ''}.`;
}

/**
 * Public tournament site.
 *
 * Canonical URLs are /tournament/:slug/:section with the navigation the
 * platform spec asks for. The original /t/:slug paths still resolve and are
 * mapped onto the same sections, so links shared before the upgrade keep
 * working.
 */
import { api } from '../lib/api.js';
import { delegate, esc, html, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import {
  barChart, emptyState, formatDate, formatDateTime, formatTime, movementIndicator,
  points, rankPill, statusBadge, teamCell, teamLogo,
} from '../lib/ui.js';
import { bindShare, shareBox, shareButton } from '../lib/share.js';
import { platformFooter, platformNav } from './chrome.js';

const SECTIONS = [
  ['overview', 'Overview', ''],
  ['teams', 'Teams', '/teams'],
  ['fixtures', 'Fixtures', '/fixtures'],
  ['live', 'Live', '/live'],
  ['results', 'Results', '/results'],
  ['standings', 'Standings', '/standings'],
  ['statistics', 'Statistics', '/statistics'],
  ['rules', 'Rules', '/rules'],
];

/** Legacy /t/:slug section names map onto the new ones. */
const ALIASES = {
  home: 'overview', matches: 'fixtures', rankings: 'standings', stats: 'statistics',
};

export default {
  title: (data) => data?.tournament?.name || 'Tournament',

  async load(ctx) {
    // Standalone match page: /t/match/:id
    if (ctx.params.matchId) {
      const list = await api.get('/api/public/tournaments');
      for (const t of list.tournaments) {
        try {
          const res = await api.get(`/api/public/t/${t.slug}/match/${ctx.params.matchId}`);
          return { kind: 'match', ...res };
        } catch { /* belongs to another tournament */ }
      }
      return { kind: 'match', match: null };
    }

    const slug = ctx.params.slug;
    const section = ALIASES[ctx.params.section] || ctx.params.section || 'overview';
    const base = await api.get(`/api/public/t/${slug}`);

    const extra = {};
    const load = {
      overview: async () => {
        const [progression, registration] = await Promise.all([
          api.get(`/api/public/t/${slug}/progression`).catch(() => null),
          api.get(`/api/public/t/${slug}/registration`).catch(() => null),
        ]);
        Object.assign(extra, { progression, registration });
      },
      fixtures: async () => { extra.matches = (await api.get(`/api/public/t/${slug}/matches`)).matches; },
      results: async () => { extra.matches = (await api.get(`/api/public/t/${slug}/matches`)).matches; },
      standings: async () => Object.assign(extra, await api.get(`/api/public/t/${slug}/leaderboard`)),
      teams: async () => { extra.teams = (await api.get(`/api/public/t/${slug}/teams`)).teams; },
      statistics: async () => {
        const [general, players] = await Promise.all([
          api.get(`/api/public/t/${slug}/stats`),
          api.get(`/api/tournaments/${base.tournament.id}/player-stats`).catch(() => null),
        ]);
        Object.assign(extra, general, { playerStats: players });
      },
      live: async () => { extra.liveData = await api.get(`/api/public/t/${slug}/live`); },
      rules: async () => { extra.rules = await api.get(`/api/public/t/${slug}/rules`); },
    }[section];
    if (load) await load();

    if (section === 'overview' || section === 'standings') {
      extra.qualification = await api.get(`/api/public/t/${slug}/qualification`).catch(() => null);
    }

    return { kind: 'tournament', slug, section, ...base, ...extra };
  },

  render(data, ctx) {
    if (data.kind === 'match') return matchPageMarkup(data, ctx);
    return tournamentMarkup(data, ctx);
  },

  mounted(data, ctx, root) {
    bindShare(root);
    delegate(root, { open: (el) => ctx.navigate(el.dataset.href) });

    // Live views refresh themselves so spectators do not have to.
    const isLive = data.kind === 'match'
      ? data.match?.status === 'live'
      : data.section === 'live' || data.live?.length > 0;

    if (isLive) {
      const timer = setInterval(() => {
        if (!document.body.contains(root)) { clearInterval(timer); return; }
        if (document.hidden) return;               // don't poll a hidden tab
        ctx.navigate(location.pathname + location.search, { replace: true });
      }, 20000);
    }
  },
};

// -------------------------------------------------------------- tournament --
function tournamentMarkup(data, ctx) {
  const { tournament, section } = data;
  const body = {
    overview: overviewSection,
    teams: teamsSection,
    fixtures: fixturesSection,
    live: liveSection,
    results: resultsSection,
    standings: standingsSection,
    statistics: statisticsSection,
    rules: rulesSection,
  }[section] || overviewSection;

  return html`
    <div class="pub">
      ${raw(platformNav(ctx, 'tournaments'))}
      <nav class="pub-nav" style="top:60px">
        <div class="pub-links grow">
          ${raw(SECTIONS.map(([key, label, path]) => `
            <a class="pub-link ${section === key ? 'active' : ''}"
               href="/tournament/${esc(tournament.slug)}${path}">${esc(label)}</a>`).join(''))}
        </div>
        ${raw(shareButton(`/tournament/${tournament.slug}`, 'Copy tournament link'))}
      </nav>
      <main class="pub-main">
        ${section === 'overview' ? raw(banner(tournament, data.stats, data.registration)) : ''}
        ${raw(body(data, ctx))}
      </main>
      ${raw(platformFooter(tournament.name))}
    </div>`;
}

function banner(tournament, stats, registration) {
  const open = registration?.state?.open;
  return `
    <div class="banner mb-3">
      ${tournament.banner_url ? `<img src="${esc(tournament.banner_url)}" alt="">` : ''}
      <div class="banner-inner">
        ${tournament.logo_url
          ? `<img src="${esc(tournament.logo_url)}" alt="" style="width:62px;height:62px;border-radius:14px;object-fit:cover;border:1px solid var(--border)">`
          : ''}
        <div class="grow" style="min-width:220px">
          <div class="row gap-sm mb-1 wrap">
            ${tournament.status === 'live'
              ? '<span class="live-pill"><span class="dot"></span>Live</span>'
              : `<span class="badge badge-neutral">${esc(tournament.status)}</span>`}
            <span class="badge badge-info">${esc(tournament.game)}</span>
            ${tournament.prize_pool ? `<span class="badge badge-warning">${icon('trophy', 11)} ${esc(tournament.prize_pool)}</span>` : ''}
            ${open ? '<span class="badge badge-qualified">Registration open</span>' : ''}
          </div>
          <h1 class="hero-title">${esc(tournament.name)}</h1>
          <div class="row wrap small muted mt-1" style="gap:14px">
            ${tournament.start_date ? `<span>${icon('calendar', 13)} ${formatDate(tournament.start_date, { withYear: true })}</span>` : ''}
            <span>${icon('teams', 13)} ${stats.teams} teams</span>
            <span>${icon('play', 13)} ${stats.completed}/${stats.matches} matches played</span>
          </div>
        </div>
        ${open ? `<a class="btn btn-primary btn-lg" href="/tournament/${esc(tournament.slug)}/register">
          ${icon('zap', 16)} Register now</a>` : ''}
      </div>
    </div>`;
}

// ---------------------------------------------------------------- sections --
function overviewSection(data) {
  const { tournament, stats, standings, live, upcoming, recent, progression, qualification, registration } = data;
  const played = standings.filter((s) => s.matches_played > 0);

  return `
    ${live.length ? `
      <div class="live-banner mb-3">
        <div class="row-between mb-2">
          <h2 style="color:var(--danger)"><span class="dot" style="display:inline-block"></span> Live now</h2>
          <a class="btn btn-sm" href="/tournament/${esc(tournament.slug)}/live">Open live view</a>
        </div>
        <div class="grid grid-auto">${live.map((m) => matchCard(m, tournament.slug)).join('')}</div>
      </div>` : ''}

    ${registration?.state?.open ? `
      <div class="reg-panel mb-3">
        <div class="row-between wrap" style="gap:14px">
          <div>
            <div class="stat-label">Registration open</div>
            <div class="reg-count">${registration.state.counts.total}${registration.state.slots ? ` / ${registration.state.slots}` : ''}
              <span class="small muted" style="font-weight:400">teams registered</span></div>
            ${registration.state.deadline ? `<div class="small muted">Closes ${formatDateTime(registration.state.deadline)}</div>` : ''}
          </div>
          <a class="btn btn-primary btn-lg" href="/tournament/${esc(tournament.slug)}/register">Register your team</a>
        </div>
      </div>` : ''}

    <div class="grid grid-stats mb-3">
      ${[
        ['Teams', stats.teams, `${stats.still_in} still in`],
        ['Matches played', `${stats.completed}/${stats.matches}`, `${stats.upcoming} to come`],
        ['Total kills', stats.total_kills, `${stats.avg_kills_per_match} per match`],
        qualifiedTile(stats, qualification),
      ].map(([label, value, meta]) => `
        <div class="stat">
          <div class="stat-label">${esc(label)}</div>
          <div class="stat-value">${esc(String(value))}</div>
          <div class="stat-meta">${esc(meta)}</div>
        </div>`).join('')}
    </div>

    <div class="grid grid-2" style="grid-template-columns:minmax(0,1.3fr) minmax(0,1fr)">
      <div class="col" style="gap:16px">
        ${progression ? progressionCard(progression, tournament) : ''}

        <div class="card">
          <div class="card-head">
            <h2>Standings</h2>
            <a class="btn btn-ghost btn-sm" href="/tournament/${esc(tournament.slug)}/standings">Full table</a>
          </div>
          <div class="card-body tight">
            ${played.length ? standingsTable(played.slice(0, 10), { compact: true })
              : emptyState({ icon: 'trophy', title: 'No results yet', message: 'Standings appear once the first match is scored.' })}
          </div>
        </div>
      </div>

      <div class="col" style="gap:16px">
        <div class="card">
          <div class="card-head">
            <h2>Upcoming</h2>
            <a class="btn btn-ghost btn-sm" href="/tournament/${esc(tournament.slug)}/fixtures">Schedule</a>
          </div>
          <div class="card-body ${upcoming.length ? '' : 'tight'}">
            ${upcoming.length
              ? `<div class="col" style="gap:9px">${upcoming.slice(0, 5).map((m) => matchCard(m, tournament.slug)).join('')}</div>`
              : emptyState({ icon: 'calendar', title: 'Nothing scheduled' })}
          </div>
        </div>

        ${recent.length ? `
          <div class="card">
            <div class="card-head"><h2>Recent results</h2>
              <a class="btn btn-ghost btn-sm" href="/tournament/${esc(tournament.slug)}/results">All</a></div>
            <div class="card-body">
              <div class="col" style="gap:9px">${recent.slice(0, 4).map((m) => matchCard(m, tournament.slug)).join('')}</div>
            </div>
          </div>` : ''}

        ${tournament.description ? `
          <div class="card">
            <div class="card-head"><h2>About</h2></div>
            <div class="card-body"><p class="small muted" style="margin:0;white-space:pre-wrap">${esc(tournament.description)}</p></div>
          </div>` : ''}

        <div class="card"><div class="card-body">${shareBox(`/tournament/${tournament.slug}`)}</div></div>
      </div>
    </div>`;
}

/** Registration -> Group Stage -> ... -> Grand Final -> Champion. */
function progressionCard(progression, tournament) {
  const { registration, steps, champion } = progression;
  const currentIndex = steps.findIndex((s) => s.status === 'live');

  const rows = [
    `<div class="flow-step done">
       <span class="flow-dot">${icon('check', 13)}</span>
       <div class="grow">
         <div style="font-weight:620">Registration</div>
         <div class="tiny dim">${registration.registered} team(s) registered${registration.slots ? ` of ${registration.slots}` : ''}</div>
       </div>
       ${registration.open ? '<span class="badge badge-qualified">Open</span>' : '<span class="badge badge-neutral">Closed</span>'}
     </div>`,
    ...steps.map((step, i) => {
      const state = step.status === 'completed' ? 'done' : (i === currentIndex ? 'current' : '');
      const badge = step.status === 'completed'
        ? '<span class="badge badge-completed">Completed</span>'
        : step.live
          ? '<span class="live-pill"><span class="dot"></span>Live</span>'
          : step.status === 'live'
            ? '<span class="badge badge-active">In progress</span>'
            : '<span class="badge badge-upcoming">Upcoming</span>';

      return `
        <div class="flow-step ${state}">
          <span class="flow-dot">${step.status === 'completed' ? icon('check', 13) : i + 1}</span>
          <div class="grow" style="min-width:0">
            <div style="font-weight:620">${esc(step.name)}</div>
            <div class="tiny dim">
              ${step.teams} teams · ${step.completed}/${step.matches} matches
              ${step.locked ? ` · ${step.qualified.length} qualified, ${step.eliminated} eliminated` : ''}
            </div>
            ${step.qualified.length ? `
              <div class="row wrap gap-sm mt-1">
                ${step.qualified.slice(0, 8).map((q) => `<span class="chip tiny">${esc(q.team_name)}</span>`).join('')}
                ${step.qualified.length > 8 ? `<span class="chip tiny dim">+${step.qualified.length - 8}</span>` : ''}
              </div>` : ''}
          </div>
          ${badge}
        </div>`;
    }),
  ];

  if (champion) {
    rows.push(`
      <div class="flow-step champion">
        <span class="flow-dot">${icon('crown', 13)}</span>
        <div class="grow">
          <div class="tiny dim">Champion</div>
          <div style="font-weight:700;font-size:16px">${esc(champion.team_name)}</div>
        </div>
        <span class="badge badge-warning">${points(champion.total_points)} pts</span>
      </div>`);
  }

  return `
    <div class="card">
      <div class="card-head"><h2>Tournament progress</h2></div>
      <div class="card-body">
        <div class="flow">${rows.join('<div class="flow-connector"></div>')}</div>
      </div>
    </div>`;
}

function qualifiedTile(stats, qualification) {
  if (stats.qualified) return ['Qualified', stats.qualified, 'Confirmed through'];
  const projected = qualification?.qualified?.length;
  if (projected) return ['Qualifying spots', projected, 'Projected, not yet final'];
  return ['Qualified', '--', 'Not decided yet'];
}

function liveSection(data) {
  const { liveData, tournament } = data;
  if (!liveData) return emptyState({ icon: 'alert', title: 'Live data unavailable' });
  const { live, next, latest_result: latest, standings, stats } = liveData;

  return `
    <div class="row-between mb-3 wrap" style="gap:12px">
      <div>
        <h1 class="hero-title" style="font-size:26px">Live</h1>
        <p class="muted small" style="margin:0">Refreshes automatically every 20 seconds.</p>
      </div>
      ${live.length ? '<span class="live-pill"><span class="dot"></span>On air</span>' : '<span class="badge badge-neutral">No match in progress</span>'}
    </div>

    ${live.length ? `
      <div class="live-banner mb-3">
        <div class="grid grid-auto">${live.map((m) => matchCard(m, tournament.slug)).join('')}</div>
      </div>`
    : next ? `
      <div class="card mb-3">
        <div class="card-head"><h2>Next match</h2></div>
        <div class="card-body"><div class="grid grid-auto">${matchCard(next, tournament.slug)}</div></div>
      </div>`
    : ''}

    <div class="grid grid-2" style="grid-template-columns:minmax(0,1.2fr) minmax(0,1fr)">
      <div class="card">
        <div class="card-head"><h2>Live standings</h2>
          <span class="small dim">${stats.completed}/${stats.matches} matches</span></div>
        <div class="card-body tight">
          ${standings.some((s) => s.matches_played) ? standingsTable(standings, { compact: true })
            : emptyState({ icon: 'trophy', title: 'No results yet' })}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Latest result</h2></div>
        <div class="card-body tight">
          ${latest ? `
            <div style="padding:12px 15px;border-bottom:1px solid var(--border-soft)">
              <div style="font-weight:650">${esc(latest.label || `Match ${latest.match_no}`)}</div>
              <div class="tiny dim">${formatDateTime(latest.scheduled_at)}${latest.map ? ` · ${esc(latest.map)}` : ''}</div>
            </div>
            <table class="data compact"><tbody>
              ${latest.results.slice(0, 8).map((r) => `
                <tr>
                  <td style="width:46px">${rankPill(r.placement || '-')}</td>
                  <td>${teamCell({ name: r.team_name, tag: r.tag, logo_url: r.logo_url }, { size: 'sm' })}</td>
                  <td class="num dim small">${r.kills} K</td>
                  <td class="num strong">${points(r.total_points)}</td>
                </tr>`).join('')}
            </tbody></table>`
          : emptyState({ icon: 'flag', title: 'No completed matches yet' })}
        </div>
      </div>
    </div>`;
}

function fixturesSection({ matches, tournament }) {
  if (!matches?.length) return emptyState({ icon: 'calendar', title: 'No fixtures published yet' });

  const upcoming = matches.filter((m) => m.status === 'upcoming' || m.status === 'live');
  const completed = matches.filter((m) => m.status === 'completed');

  return `
    <h1 class="mb-3">Fixtures</h1>
    ${upcoming.length ? `
      <div class="row-between mb-2"><h2>Upcoming matches</h2><span class="small dim">${upcoming.length}</span></div>
      <div class="grid grid-auto mb-3">${upcoming.map((m) => matchCard(m, tournament.slug)).join('')}</div>` : ''}

    ${completed.length ? `
      <div class="row-between mb-2"><h2>Completed matches</h2><span class="small dim">${completed.length}</span></div>
      <div class="card">
        <div class="card-body tight">
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Match</th><th>Stage</th><th>Group</th><th>Winner</th><th>Date</th><th>Status</th></tr></thead>
              <tbody>
                ${completed.map((m) => `
                  <tr style="cursor:pointer" data-act="open" data-href="/t/match/${m.id}">
                    <td class="strong">Match ${m.match_no}</td>
                    <td class="small muted">${esc(m.stage_name || '--')}</td>
                    <td>${m.group_name ? `<span class="badge badge-neutral">${esc(m.group_name)}</span>` : '<span class="dim">--</span>'}</td>
                    <td class="small">${m.winner
                      ? `${icon('crown', 12)} ${esc(m.teams.find((t) => t.team_id === m.winner.team_id)?.name || 'Winner')}`
                      : '<span class="dim">--</span>'}</td>
                    <td class="small nowrap">${formatDate(m.scheduled_at)}</td>
                    <td>${statusBadge(m.status)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>` : ''}`;
}

function standingsSection({ standings, groups, qualification }) {
  const played = standings.filter((s) => s.matches_played > 0);
  const qualifyingIds = new Set((qualification?.qualified || []).map((q) => q.team_id));

  return `
    <div class="row-between mb-2 wrap">
      <h1>Standings</h1>
      <span class="small dim">Recalculated after every result</span>
    </div>
    ${qualification && !qualification.locked && qualifyingIds.size ? `
      <div class="info-box mb-2">${icon('info', 15)}
        <div>Highlighted rows are currently projected to qualify. Nothing is final until the organizer locks the cut.</div>
      </div>` : ''}
    <div class="card">
      <div class="card-body tight">
        ${played.length ? standingsTable(standings, { qualifyingIds })
          : emptyState({ icon: 'trophy', title: 'No results yet' })}
      </div>
    </div>

    ${groups?.length > 1 ? `
      <h2 class="mt-3 mb-2">By group</h2>
      <div class="grid grid-2">
        ${groups.map((g) => `
          <div class="card">
            <div class="card-head"><h2>${esc(g.group.name)}</h2></div>
            <div class="card-body tight">${standingsTable(g.standings, { compact: true })}</div>
          </div>`).join('')}
      </div>` : ''}`;
}

function standingsTable(rows, { compact = false, qualifyingIds = null } = {}) {
  return `
    <div class="table-wrap">
      <table class="data ${compact ? 'compact' : ''}">
        <thead>
          <tr>
            <th style="width:52px">#</th><th>Team</th>
            ${compact ? '' : '<th>Group</th>'}
            <th class="num">Pld</th><th class="num">WWCD</th>
            ${compact ? '' : '<th class="num">Place</th><th class="num">Kill pts</th>'}
            <th class="num">Kills</th>
            ${compact ? '' : '<th class="num">Avg</th>'}
            <th class="num">Points</th><th style="width:42px"></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((s) => `
            <tr class="${s.status === 'qualified' || qualifyingIds?.has(s.team_id) ? 'is-qualified' : ''} ${s.disqualified ? 'is-eliminated' : ''}">
              <td class="keep">${rankPill(s.rank)}</td>
              <td class="keep">
                ${teamCell({ name: s.team_name, tag: s.tag, logo_url: s.logo_url }, { size: compact ? 'sm' : '' })}
                ${s.disqualified ? '<span class="badge badge-eliminated" style="margin-left:6px">DQ</span>' : ''}
              </td>
              ${compact ? '' : `<td>${s.group_name ? `<span class="badge badge-neutral">${esc(s.group_name)}</span>` : '<span class="dim">--</span>'}</td>`}
              <td class="num">${s.matches_played}</td>
              <td class="num">${s.wins ? `<span style="color:var(--gold);font-weight:650">${s.wins}</span>` : '0'}</td>
              ${compact ? '' : `<td class="num">${points(s.placement_points)}</td><td class="num">${points(s.kill_points)}</td>`}
              <td class="num">${s.total_kills}</td>
              ${compact ? '' : `<td class="num dim">${points(s.avg_points)}</td>`}
              <td class="num strong" style="font-size:14px">${points(s.total_points)}</td>
              <td>${movementIndicator(s.movement)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function teamsSection({ teams }) {
  if (!teams?.length) return emptyState({ icon: 'teams', title: 'No teams registered yet' });
  return `
    <h1 class="mb-3">Teams <span class="muted" style="font-weight:400">(${teams.length})</span></h1>
    <div class="grid grid-auto">
      ${teams.map((t) => `
        <div class="card">
          <div class="card-body">
            <div class="row" style="gap:11px">
              ${teamLogo(t, 'lg')}
              <div class="grow" style="min-width:0">
                <div class="truncate" style="font-weight:650">${esc(t.name)}</div>
                <div class="tiny dim">${esc(t.tag || t.team_code || '')}</div>
              </div>
              ${t.status === 'qualified' ? '<span class="badge badge-qualified">Qualified</span>'
                : t.status === 'eliminated' ? '<span class="badge badge-eliminated">Out</span>' : ''}
            </div>
            ${t.group_name ? `<div class="mt-2"><span class="badge badge-neutral">${esc(t.group_name)}</span></div>` : ''}
            ${t.players.length ? `
              <div class="divider" style="margin:11px 0"></div>
              <div class="col" style="gap:4px">
                ${t.players.map((p) => `
                  <div class="row-between small">
                    <span>${p.is_captain ? `<span style="color:var(--gold)">${icon('crown', 11)}</span> ` : ''}${esc(p.name)}</span>
                    <span class="tiny dim mono">${esc(p.in_game_id || '')}</span>
                  </div>`).join('')}
              </div>` : ''}
          </div>
        </div>`).join('')}
    </div>`;
}

function resultsSection({ matches, tournament }) {
  const completed = (matches || []).filter((m) => m.status === 'completed');
  if (!completed.length) return emptyState({ icon: 'flag', title: 'No results yet', message: 'Completed matches show up here.' });

  return `
    <h1 class="mb-3">Results</h1>
    <div class="grid grid-auto">
      ${completed.slice().reverse().map((m) => `
        <div class="card" style="cursor:pointer" data-act="open" data-href="/t/match/${m.id}">
          <div class="card-head">
            <h2 style="font-size:15px">Match ${m.match_no}</h2>
            ${statusBadge(m.status)}
          </div>
          <div class="card-body">
            <div class="row wrap small muted mb-2" style="gap:12px">
              <span>${icon('calendar', 13)} ${formatDate(m.scheduled_at)}</span>
              ${m.map ? `<span>${esc(m.map)}</span>` : ''}
              ${m.group_name ? `<span>${esc(m.group_name)}</span>` : ''}
            </div>
            ${m.winner ? `
              <div class="row" style="gap:9px;padding:9px;background:var(--success-dim);border-radius:9px;border:1px solid rgba(52,211,153,0.3)">
                <span style="color:var(--gold)">${icon('crown', 15)}</span>
                <span class="grow small" style="font-weight:600">
                  ${esc(m.teams.find((t) => t.team_id === m.winner.team_id)?.name || 'Winner')}</span>
                <span class="mono small">${m.winner.kills} kills</span>
              </div>` : '<div class="small dim">Result recorded</div>'}
          </div>
        </div>`).join('')}
    </div>`;
}

function statisticsSection({ stats, kill_leaders: killLeaders, consistency, most_wins: mostWins, per_match: perMatch, playerStats }) {
  const individual = playerStats?.individual;

  return `
    <h1 class="mb-3">Statistics</h1>
    <div class="grid grid-stats mb-3">
      ${[
        ['Total kills', stats.total_kills, `${stats.avg_kills_per_match} per match`],
        ['Matches played', stats.completed, `of ${stats.matches}`],
        ['Teams', stats.teams, `${stats.still_in} still in`],
        ['Top fragger', stats.top_fragger?.team_name || '--', stats.top_fragger ? `${stats.top_fragger.total_kills} kills` : ''],
      ].map(([label, value, meta]) => `
        <div class="stat">
          <div class="stat-label">${esc(label)}</div>
          <div class="stat-value" style="font-size:${String(value).length > 9 ? '17px' : '27px'}">${esc(String(value))}</div>
          <div class="stat-meta">${esc(meta)}</div>
        </div>`).join('')}
    </div>

    ${perMatch?.length ? `
      <div class="card mb-3">
        <div class="card-head"><h2>Kills per match</h2></div>
        <div class="card-body">${barChart(perMatch.map((p) => ({ label: `M${p.match_no}`, value: p.kills })), { height: 180 })}</div>
      </div>` : ''}

    ${playerStats ? `
      <div class="grid grid-2 mb-3">
        <div class="card">
          <div class="card-head"><h2>${individual ? 'Top killers' : 'Players'}</h2>
            ${individual ? '' : '<span class="badge badge-neutral">team figures</span>'}</div>
          <div class="card-body tight">
            ${!individual ? `<div class="info-box" style="margin:12px 15px">${icon('info', 15)}
              <div>Per-player kills have not been recorded for this tournament, so these are the players' team results.</div></div>` : ''}
            <table class="data compact"><tbody>
              ${playerStats.players.slice(0, 10).map((p, i) => `
                <tr>
                  <td style="width:44px">${rankPill(i + 1)}</td>
                  <td><span style="font-weight:600">${esc(p.name)}</span>
                      <div class="tiny dim">${esc(p.team_name)}</div></td>
                  <td class="num strong">${individual ? `${p.kills} K` : `${points(p.team_points)} pts`}</td>
                </tr>`).join('')}
            </tbody></table>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>MVP</h2><span class="small dim">weighted score</span></div>
          <div class="card-body tight">
            <table class="data compact"><tbody>
              ${playerStats.mvp.players.slice(0, 10).map((p, i) => `
                <tr>
                  <td style="width:44px">${rankPill(i + 1)}</td>
                  <td><span style="font-weight:600">${esc(p.name)}</span>
                      <div class="tiny dim">${esc(p.team_name)}${individual ? ` · ${p.kills} kills` : ''}</div></td>
                  <td class="num strong">${p.mvp_score}</td>
                </tr>`).join('')}
            </tbody></table>
          </div>
        </div>
      </div>` : ''}

    <div class="grid grid-3">
      ${[
        ['Most kills (team)', killLeaders, (s) => `${s.total_kills} kills`],
        ['Most consistent', consistency, (s) => `${points(s.avg_points)} avg pts`],
        ['Most wins', mostWins, (s) => `${s.wins} WWCD`],
      ].map(([title, list, format]) => `
        <div class="card">
          <div class="card-head"><h2>${esc(title)}</h2></div>
          <div class="card-body tight">
            ${list?.length ? `
              <table class="data compact"><tbody>
                ${list.slice(0, 8).map((s, i) => `
                  <tr>
                    <td style="width:44px">${rankPill(i + 1)}</td>
                    <td>${teamCell({ name: s.team_name || s.name, tag: s.tag, logo_url: s.logo_url }, { size: 'sm' })}</td>
                    <td class="num small strong nowrap">${esc(format(s))}</td>
                  </tr>`).join('')}
              </tbody></table>`
            : '<div class="empty"><span class="small muted">No data yet</span></div>'}
          </div>
        </div>`).join('')}
    </div>`;
}

function rulesSection({ rules, tournament }) {
  if (!rules) return emptyState({ icon: 'file', title: 'Rules unavailable' });
  const placement = Object.entries(rules.scoring?.placementPoints || {});

  return `
    <h1 class="mb-3">Rules</h1>
    <div class="grid grid-2" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)">
      <div class="card">
        <div class="card-body">
          ${rules.rules_html
            ? `<div class="prose">${rules.rules_html}</div>`
            : emptyState({ icon: 'file', title: 'No written rules yet', message: 'The organizer has not published a rulebook for this tournament.' })}
          ${rules.entry_requirements ? `
            <div class="divider"></div>
            <h3 class="mb-1">Entry requirements</h3>
            <p class="small muted" style="white-space:pre-wrap;margin:0">${esc(rules.entry_requirements)}</p>` : ''}
        </div>
      </div>

      <div class="col" style="gap:16px">
        <div class="card">
          <div class="card-head"><h2>Scoring</h2></div>
          <div class="card-body">
            <dl class="kv">
              <dt>Per kill</dt><dd>${rules.scoring?.killPoints ?? 1} point(s)</dd>
              ${rules.scoring?.winBonus ? `<dt>Win bonus</dt><dd>${rules.scoring.winBonus}</dd>` : ''}
            </dl>
            ${placement.length ? `
              <div class="divider"></div>
              <div class="label mb-1">Placement points</div>
              <div class="row wrap gap-sm">
                ${placement.slice(0, 16).map(([place, pts]) => `
                  <span class="chip"><b>#${esc(place)}</b> ${esc(pts)}</span>`).join('')}
              </div>` : ''}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Format</h2></div>
          <div class="card-body">
            <dl class="kv">
              <dt>Type</dt><dd>${esc(rules.format.type)}</dd>
              <dt>Match format</dt><dd>${esc(rules.format.match_format)}</dd>
              <dt>Teams</dt><dd>${rules.format.num_teams}</dd>
              <dt>Groups</dt><dd>${rules.format.num_groups}</dd>
              <dt>Per lobby</dt><dd>${rules.format.teams_per_match}</dd>
              <dt>Squad size</dt><dd>${rules.format.min_players}–${rules.format.max_players}</dd>
            </dl>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Tie-breakers</h2></div>
          <div class="card-body">
            <ol class="small muted" style="margin:0;padding-left:20px">
              ${(rules.tiebreakers || []).map((t) => `<li>${esc(String(t).replace(/_/g, ' '))}</li>`).join('')}
            </ol>
          </div>
        </div>
      </div>
    </div>`;
}

// ------------------------------------------------------------- match page --
function matchPageMarkup({ match, tournament }, ctx) {
  if (!match) {
    return `<div class="pub">${platformNav(ctx, null)}<main class="pub-main">
      ${emptyState({ icon: 'alert', title: 'Match not found', message: 'It may belong to a tournament that is not public.' })}
    </main>${platformFooter()}</div>`;
  }

  const results = [...match.results].sort((a, b) => (a.placement ?? 999) - (b.placement ?? 999));

  return html`
    <div class="pub">
      ${raw(platformNav(ctx, 'tournaments'))}
      <main class="pub-main" style="max-width:1000px">
        <div class="row-between wrap mb-3" style="gap:14px">
          <div>
            <div class="row small muted gap-sm mb-1">
              <a href="/tournament/${esc(tournament?.slug || '')}/fixtures">Fixtures</a>
              <span class="dim">/</span><span>${match.stage_name}</span>
            </div>
            <h1 class="hero-title">${match.label || `Match ${match.match_no}`}</h1>
            <div class="row wrap small muted mt-1" style="gap:14px">
              <span>${raw(icon('calendar', 13))} ${formatDateTime(match.scheduled_at)}</span>
              ${match.map ? raw(`<span>${esc(match.map)}</span>`) : ''}
              ${match.group_name ? raw(`<span>${esc(match.group_name)}</span>`) : ''}
            </div>
          </div>
          <div class="col" style="align-items:flex-end;gap:8px">
            ${match.status === 'live' ? raw('<span class="live-pill"><span class="dot"></span>Live</span>') : raw(statusBadge(match.status))}
            ${raw(credentialsBlock(match))}
          </div>
        </div>

        ${match.status === 'live' ? raw(`
          <div class="warn-box mb-3">${icon('info', 15)}
            <div>This match is live. Scores refresh automatically every 20 seconds.</div></div>`) : ''}

        <div class="card">
          <div class="card-head">
            <h2>${results.length ? 'Result' : 'Lineup'}</h2>
            <span class="small dim">${match.participants.length} teams</span>
          </div>
          <div class="card-body tight">
            ${results.length ? raw(`
              <div class="table-wrap">
                <table class="data">
                  <thead><tr><th style="width:60px">Place</th><th>Team</th><th class="num">Kills</th>
                    <th class="num">Place pts</th><th class="num">Kill pts</th><th class="num">Bonus</th>
                    <th class="num">Penalty</th><th class="num">Total</th></tr></thead>
                  <tbody>
                    ${results.map((r) => `
                      <tr>
                        <td>${rankPill(r.placement || '-')}</td>
                        <td>${teamCell({ name: r.team_name, tag: r.tag, logo_url: r.logo_url })}</td>
                        <td class="num">${r.kills}</td>
                        <td class="num">${points(r.placement_points)}</td>
                        <td class="num">${points(r.kill_points)}</td>
                        <td class="num ${r.bonus_points ? '' : 'dim'}">${points(r.bonus_points)}</td>
                        <td class="num ${r.penalty_points ? '' : 'dim'}">${r.penalty_points ? `-${points(r.penalty_points)}` : '0'}</td>
                        <td class="num strong" style="font-size:14px">${points(r.total_points)}</td>
                      </tr>`).join('')}
                  </tbody>
                </table>
              </div>`)
            : raw(`<div class="col" style="gap:0">
                ${match.participants.map((p, i) => `
                  <div class="row" style="gap:10px;padding:10px 16px;border-bottom:1px solid var(--border-soft)">
                    <span class="dim tiny num" style="width:20px">${i + 1}</span>
                    ${teamCell(p)}
                  </div>`).join('')}
              </div>`)}
          </div>
        </div>

        <div class="card mt-3"><div class="card-body">${raw(shareBox(`/t/match/${match.id}`, { label: 'Share this match' }))}</div></div>
      </main>
      ${raw(platformFooter(tournament?.name))}
    </div>`;
}

/** Room details, or an honest explanation of why they are not shown. */
function credentialsBlock(match) {
  const c = match.credentials || {};
  if (match.room_id) {
    return `<div class="credentials">${icon('key', 14)} Room ${esc(match.room_id)} · ${esc(match.room_password || '--')}</div>`;
  }
  if (c.reason === 'participants_only') {
    return `<div class="locked small">${icon('lock', 13)} Room details released to the teams playing</div>`;
  }
  if (c.reveal_at) {
    return `<div class="locked small">${icon('lock', 13)} Room details at ${formatTime(c.reveal_at)}</div>`;
  }
  return '';
}

// ----------------------------------------------------------------- shared --
function matchCard(m, slug) {
  const c = m.credentials || {};
  return `
    <div class="match-card ${m.status === 'live' ? 'live' : ''}" style="cursor:pointer"
         data-act="open" data-href="/t/match/${m.id}">
      <div class="row-between">
        <span style="font-weight:620">Match ${m.match_no}</span>
        ${m.status === 'live' ? '<span class="live-pill"><span class="dot"></span>Live</span>' : statusBadge(m.status)}
      </div>
      <div class="row wrap small muted" style="gap:12px">
        <span>${icon('calendar', 13)} ${formatDate(m.scheduled_at)} ${formatTime(m.scheduled_at)}</span>
        ${m.map ? `<span>${esc(m.map)}</span>` : ''}
        ${m.group_name ? `<span>${esc(m.group_name)}</span>` : ''}
      </div>
      ${m.room_id
        ? `<div class="credentials tiny">${icon('key', 12)} ${esc(m.room_id)} / ${esc(m.room_password || '--')}</div>`
        : c.reveal_at
          ? `<div class="locked tiny">${icon('lock', 12)} Room at ${formatTime(c.reveal_at)}</div>`
          : c.reason === 'participants_only'
            ? `<div class="locked tiny">${icon('lock', 12)} Room sent to participants</div>`
            : ''}
    </div>`;
}

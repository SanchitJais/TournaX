/**
 * Public spectator site: tournament browser, home, matches, rankings, teams,
 * results, statistics, and the live match page.
 */
import { api } from '../lib/api.js';
import { delegate, esc, html, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import {
  barChart, emptyState, formatDate, formatDateTime, formatTime, movementIndicator,
  points, rankPill, statusBadge, teamCell, teamLogo,
} from '../lib/ui.js';

const SECTIONS = [
  ['home', 'Home'], ['matches', 'Matches'], ['rankings', 'Rankings'],
  ['teams', 'Teams'], ['results', 'Results'], ['stats', 'Statistics'],
];

export default {
  title: (data) => data?.tournament?.name || 'Tournaments',

  async load(ctx) {
    // Standalone match page.
    if (ctx.params.matchId) {
      const list = await api.get('/api/public/tournaments');
      for (const t of list.tournaments) {
        try {
          const res = await api.get(`/api/public/t/${t.slug}/match/${ctx.params.matchId}`);
          return { kind: 'match', ...res };
        } catch { /* try the next tournament */ }
      }
      return { kind: 'match', match: null };
    }

    if (!ctx.params.slug) {
      const list = await api.get('/api/public/tournaments');
      return { kind: 'browse', tournaments: list.tournaments };
    }

    const slug = ctx.params.slug;
    const section = ctx.params.section || 'home';
    const home = await api.get(`/api/public/t/${slug}`);

    const extra = {};
    if (section === 'matches' || section === 'results') {
      extra.matches = (await api.get(`/api/public/t/${slug}/matches`)).matches;
    }
    if (section === 'rankings') Object.assign(extra, await api.get(`/api/public/t/${slug}/leaderboard`));
    if (section === 'teams') extra.teams = (await api.get(`/api/public/t/${slug}/teams`)).teams;
    if (section === 'stats') Object.assign(extra, await api.get(`/api/public/t/${slug}/stats`));
    if (section === 'home') extra.qualification = await api.get(`/api/public/t/${slug}/qualification`).catch(() => null);

    return { kind: 'tournament', slug, section, ...home, ...extra };
  },

  render(data, ctx) {
    if (data.kind === 'browse') return browseMarkup(data);
    if (data.kind === 'match') return matchPageMarkup(data);
    return tournamentMarkup(data);
  },

  mounted(data, ctx, root) {
    delegate(root, {
      open: (el) => ctx.navigate(el.dataset.href),
    });

    // Keep a live match page fresh without a manual refresh.
    if (data.kind === 'match' && data.match?.status === 'live') {
      const timer = setInterval(() => {
        if (!document.body.contains(root)) { clearInterval(timer); return; }
        ctx.navigate(location.pathname, { replace: true });
      }, 20000);
    }
  },
};

// ------------------------------------------------------------------ browse --
function browseMarkup({ tournaments }) {
  return html`
    <div class="pub">
      ${raw(navBar(null, null))}
      <main class="pub-main">
        <div class="mb-3">
          <h1 class="hero-title">Tournaments</h1>
          <p class="muted">Live standings, schedules and results.</p>
        </div>

        ${tournaments.length ? raw(`
          <div class="grid grid-auto">
            ${tournaments.map((t) => `
              <a class="tournament-card" href="/t/${esc(t.slug)}">
                <div class="thumb">${t.banner_url ? `<img src="${esc(t.banner_url)}" alt="">` : ''}</div>
                <div style="padding:14px 15px">
                  <div class="row-between" style="align-items:flex-start">
                    <div class="grow" style="min-width:0">
                      <div class="truncate" style="font-weight:650;font-size:15px">${esc(t.name)}</div>
                      <div class="tiny dim">${esc(t.game)}</div>
                    </div>
                    <span class="badge badge-${t.status === 'live' ? 'live' : 'neutral'}">
                      ${t.status === 'live' ? '<span class="dot"></span>' : ''}${esc(t.status)}</span>
                  </div>
                  <div class="row mt-2 small muted" style="gap:14px">
                    <span>${icon('teams', 13)} ${t.team_count}</span>
                    <span>${icon('calendar', 13)} ${t.completed}/${t.matches}</span>
                    ${t.prize_pool ? `<span>${icon('trophy', 13)} ${esc(t.prize_pool)}</span>` : ''}
                  </div>
                </div>
              </a>`).join('')}
          </div>`) : raw(emptyState({
            icon: 'trophy', title: 'No public tournaments yet',
            message: 'Once an organizer publishes a tournament it will appear here.',
            action: '<a class="btn btn-primary mt-2" href="/admin">Organizer sign-in</a>',
          }))}
      </main>
      ${raw(footer())}
    </div>`;
}

// -------------------------------------------------------------- tournament --
function tournamentMarkup(data) {
  const { tournament, section } = data;
  const body = {
    home: homeSection,
    matches: matchesSection,
    rankings: rankingsSection,
    teams: teamsSection,
    results: resultsSection,
    stats: statsSection,
  }[section] || homeSection;

  return html`
    <div class="pub">
      ${raw(navBar(tournament, section))}
      <main class="pub-main">
        ${section === 'home' ? raw(banner(tournament, data.stats)) : ''}
        ${raw(body(data))}
      </main>
      ${raw(footer(tournament))}
    </div>`;
}

function navBar(tournament, section) {
  return `
    <nav class="pub-nav">
      <a class="row" href="${tournament ? `/t/${esc(tournament.slug)}` : '/'}" style="gap:10px;flex-shrink:0">
        ${tournament?.logo_url
          ? `<img src="${esc(tournament.logo_url)}" alt="" style="width:30px;height:30px;border-radius:8px;object-fit:cover">`
          : '<span class="brand-mark" style="width:30px;height:30px;font-size:13px">TM</span>'}
        <span class="truncate" style="font-weight:650;max-width:220px">
          ${esc(tournament?.name || 'Tournament Manager')}</span>
      </a>
      ${tournament ? `
        <div class="pub-links grow">
          ${SECTIONS.map(([key, label]) => `
            <a class="pub-link ${section === key ? 'active' : ''}"
               href="/t/${esc(tournament.slug)}${key === 'home' ? '' : `/${key}`}">${esc(label)}</a>`).join('')}
        </div>` : '<div class="grow"></div>'}
      <a class="btn btn-ghost btn-sm" href="/admin">Organizer</a>
    </nav>`;
}

function banner(tournament, stats) {
  return `
    <div class="banner mb-3">
      ${tournament.banner_url ? `<img src="${esc(tournament.banner_url)}" alt="">` : ''}
      <div class="banner-inner">
        ${tournament.logo_url
          ? `<img src="${esc(tournament.logo_url)}" alt="" style="width:62px;height:62px;border-radius:14px;object-fit:cover;border:1px solid var(--border)">`
          : ''}
        <div class="grow" style="min-width:220px">
          <div class="row gap-sm mb-1">
            <span class="badge badge-${tournament.status === 'live' ? 'live' : 'neutral'}">
              ${tournament.status === 'live' ? '<span class="dot"></span>' : ''}${esc(tournament.status)}</span>
            <span class="badge badge-info">${esc(tournament.game)}</span>
            ${tournament.prize_pool ? `<span class="badge badge-warning">${icon('trophy', 11)} ${esc(tournament.prize_pool)}</span>` : ''}
          </div>
          <h1 class="hero-title">${esc(tournament.name)}</h1>
          <div class="row wrap small muted mt-1" style="gap:14px">
            ${tournament.start_date ? `<span>${icon('calendar', 13)} ${formatDate(tournament.start_date, { withYear: true })}</span>` : ''}
            <span>${icon('teams', 13)} ${stats.teams} teams</span>
            <span>${icon('play', 13)} ${stats.completed}/${stats.matches} matches played</span>
          </div>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- sections --
function homeSection(data) {
  const { tournament, stats, standings, live, upcoming, recent, qualification } = data;
  const played = standings.filter((s) => s.matches_played > 0);

  return `
    ${live.length ? `
      <div class="card mb-3" style="border-color:rgba(251,92,115,0.45)">
        <div class="card-head">
          <h2 style="color:var(--danger)"><span class="dot" style="display:inline-block"></span> Live now</h2>
        </div>
        <div class="card-body">
          <div class="grid grid-auto">
            ${live.map((m) => matchCard(m, tournament.slug)).join('')}
          </div>
        </div>
      </div>` : ''}

    <div class="grid grid-stats mb-3">
      ${[
        ['Teams', stats.teams, `${stats.still_in} still in`],
        ['Matches played', `${stats.completed}/${stats.matches}`, `${stats.upcoming} to come`],
        ['Total kills', stats.total_kills, `${stats.avg_kills_per_match} per match`],
        // Before the cut is locked this is a projection off the live standings,
        // which is what the Qualified panel below is showing too.
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
        <div class="card">
          <div class="card-head">
            <h2>Standings</h2>
            <a class="btn btn-ghost btn-sm" href="/t/${esc(tournament.slug)}/rankings">Full table</a>
          </div>
          <div class="card-body tight">
            ${played.length ? `
              <div class="table-wrap">
                <table class="data compact">
                  <thead><tr><th style="width:48px">#</th><th>Team</th><th class="num">Pld</th>
                    <th class="num">WWCD</th><th class="num">Kills</th><th class="num">Points</th><th style="width:40px"></th></tr></thead>
                  <tbody>
                    ${played.slice(0, 12).map((s) => `
                      <tr>
                        <td>${rankPill(s.rank)}</td>
                        <td>${teamCell({ name: s.team_name, tag: s.tag, logo_url: s.logo_url }, { size: 'sm' })}</td>
                        <td class="num">${s.matches_played}</td>
                        <td class="num">${s.wins}</td>
                        <td class="num">${s.total_kills}</td>
                        <td class="num strong">${points(s.total_points)}</td>
                        <td>${movementIndicator(s.movement)}</td>
                      </tr>`).join('')}
                  </tbody>
                </table>
              </div>`
            : emptyState({ icon: 'trophy', title: 'No results yet', message: 'Standings appear once the first match is scored.' })}
          </div>
        </div>

        ${recent.length ? `
          <div class="card">
            <div class="card-head">
              <h2>Recent results</h2>
              <a class="btn btn-ghost btn-sm" href="/t/${esc(tournament.slug)}/results">All results</a>
            </div>
            <div class="card-body">
              <div class="grid grid-auto">${recent.map((m) => matchCard(m, tournament.slug)).join('')}</div>
            </div>
          </div>` : ''}
      </div>

      <div class="col" style="gap:16px">
        <div class="card">
          <div class="card-head">
            <h2>Upcoming</h2>
            <a class="btn btn-ghost btn-sm" href="/t/${esc(tournament.slug)}/matches">Schedule</a>
          </div>
          <div class="card-body">
            ${upcoming.length ? `<div class="col" style="gap:9px">
              ${upcoming.slice(0, 6).map((m) => matchCard(m, tournament.slug)).join('')}</div>`
            : emptyState({ icon: 'calendar', title: 'Nothing scheduled' })}
          </div>
        </div>

        ${qualification?.qualified?.length ? `
          <div class="card">
            <div class="card-head">
              <h2 style="color:var(--success)">${icon('crown', 15)} ${qualification.locked ? 'Qualified' : 'Projected to qualify'}</h2>
              <span class="badge ${qualification.locked ? 'badge-qualified' : 'badge-info'}">
                ${qualification.locked ? qualification.qualified.length : `${qualification.qualified.length} projected`}</span>
            </div>
            ${qualification.locked ? '' : `
              <div class="small dim" style="padding:9px 15px 0">
                Based on the standings so far. Not final until the stage ends.
              </div>`}
            <div class="card-body tight">
              ${qualification.qualified.slice(0, 12).map((t, i) => `
                <div class="row" style="gap:9px;padding:7px 15px;border-bottom:1px solid var(--border-soft)">
                  ${rankPill(t.rank || i + 1)}
                  ${teamCell({ name: t.team_name, tag: t.tag, logo_url: t.logo_url }, { size: 'sm' })}
                </div>`).join('')}
            </div>
          </div>` : ''}

        ${tournament.description ? `
          <div class="card">
            <div class="card-head"><h2>About</h2></div>
            <div class="card-body"><p class="small muted" style="margin:0;white-space:pre-wrap">${esc(tournament.description)}</p></div>
          </div>` : ''}
      </div>
    </div>`;
}

/** Qualified count, labelled honestly depending on whether the cut is locked. */
function qualifiedTile(stats, qualification) {
  if (stats.qualified) return ['Qualified', stats.qualified, 'Confirmed through'];
  const projected = qualification?.qualified?.length;
  if (projected) return ['Qualifying spots', projected, 'Projected, not yet final'];
  return ['Qualified', '--', 'Not decided yet'];
}

function matchesSection({ matches, tournament }) {
  if (!matches?.length) return emptyState({ icon: 'calendar', title: 'No matches scheduled yet' });
  const byStage = groupBy(matches, (m) => m.stage_name);

  return `
    <h1 class="mb-2">Match schedule</h1>
    ${[...byStage.entries()].map(([stage, list]) => `
      <div class="card mb-3">
        <div class="card-head"><h2>${esc(stage)}</h2><span class="small dim">${list.length} matches</span></div>
        <div class="card-body tight">
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th style="width:88px">Match</th><th>Group</th><th>Teams</th><th>Map</th>
                <th>Date</th><th>Time</th><th>Room</th><th>Status</th></tr></thead>
              <tbody>
                ${list.map((m) => `
                  <tr style="cursor:pointer" data-act="open" data-href="/t/match/${m.id}">
                    <td class="strong">Match ${m.match_no}</td>
                    <td>${m.group_name ? `<span class="badge badge-neutral">${esc(m.group_name)}</span>` : '<span class="dim">--</span>'}</td>
                    <td class="small muted truncate" style="max-width:280px">${m.teams.length} teams</td>
                    <td class="small">${esc(m.map || '--')}</td>
                    <td class="small nowrap">${formatDate(m.scheduled_at)}</td>
                    <td class="small nowrap">${formatTime(m.scheduled_at)}</td>
                    <td class="small">${publicRoom(m)}</td>
                    <td>${statusBadge(m.status)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>`).join('')}`;
}

function rankingsSection({ standings, groups, tournament }) {
  const played = standings.filter((s) => s.matches_played > 0);
  return `
    <div class="row-between mb-2 wrap">
      <h1>Rankings</h1>
      <span class="small dim">Updated automatically after every result</span>
    </div>
    <div class="card">
      <div class="card-body tight">
        ${played.length ? `
          <div class="table-wrap">
            <table class="data">
              <thead><tr>
                <th style="width:52px">Rank</th><th>Team</th><th>Group</th>
                <th class="num">Pld</th><th class="num">WWCD</th><th class="num">Place</th>
                <th class="num">Kill pts</th><th class="num">Kills</th><th class="num">Avg</th><th class="num">Total</th><th style="width:44px"></th>
              </tr></thead>
              <tbody>
                ${standings.map((s) => `
                  <tr class="${s.status === 'qualified' ? 'is-qualified' : ''}">
                    <td class="keep">${rankPill(s.rank)}</td>
                    <td class="keep">${teamCell({ name: s.team_name, tag: s.tag, logo_url: s.logo_url })}</td>
                    <td>${s.group_name ? `<span class="badge badge-neutral">${esc(s.group_name)}</span>` : '<span class="dim">--</span>'}</td>
                    <td class="num">${s.matches_played}</td>
                    <td class="num">${s.wins}</td>
                    <td class="num">${points(s.placement_points)}</td>
                    <td class="num">${points(s.kill_points)}</td>
                    <td class="num">${s.total_kills}</td>
                    <td class="num dim">${points(s.avg_points)}</td>
                    <td class="num strong" style="font-size:14px">${points(s.total_points)}</td>
                    <td>${movementIndicator(s.movement)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>`
        : emptyState({ icon: 'trophy', title: 'No results yet' })}
      </div>
    </div>

    ${groups?.length > 1 ? `
      <h2 class="mt-3 mb-2">By group</h2>
      <div class="grid grid-2">
        ${groups.map((g) => `
          <div class="card">
            <div class="card-head"><h2>${esc(g.group.name)}</h2></div>
            <div class="card-body tight">
              <table class="data compact">
                <tbody>
                  ${g.standings.map((s) => `
                    <tr>
                      <td style="width:46px">${rankPill(s.rank)}</td>
                      <td>${teamCell({ name: s.team_name, tag: s.tag, logo_url: s.logo_url }, { size: 'sm' })}</td>
                      <td class="num dim small">${s.total_kills} K</td>
                      <td class="num strong">${points(s.total_points)}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>
          </div>`).join('')}
      </div>` : ''}`;
}

function teamsSection({ teams }) {
  if (!teams?.length) return emptyState({ icon: 'teams', title: 'No teams registered yet' });
  return `
    <h1 class="mb-2">Teams <span class="muted" style="font-weight:400">(${teams.length})</span></h1>
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
    <h1 class="mb-2">Results</h1>
    <div class="grid grid-auto">
      ${completed.reverse().map((m) => `
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

function statsSection({ stats, kill_leaders, consistency, most_wins, per_match }) {
  return `
    <h1 class="mb-2">Statistics</h1>
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

    ${per_match?.length ? `
      <div class="card mb-3">
        <div class="card-head"><h2>Kills per match</h2></div>
        <div class="card-body">${barChart(per_match.map((p) => ({ label: `M${p.match_no}`, value: p.kills })), { height: 180 })}</div>
      </div>` : ''}

    <div class="grid grid-3">
      ${[
        ['Most kills', kill_leaders, (s) => `${s.total_kills} kills`],
        ['Most consistent', consistency, (s) => `${points(s.avg_points)} avg pts`],
        ['Most wins', most_wins, (s) => `${s.wins} WWCD`],
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

// ------------------------------------------------------------ match page ---
function matchPageMarkup({ match, tournament }) {
  if (!match) {
    return `<div class="pub">${navBar(null, null)}<main class="pub-main">
      ${emptyState({ icon: 'alert', title: 'Match not found', message: 'It may belong to a tournament that is not public.' })}
    </main>${footer()}</div>`;
  }

  const results = [...match.results].sort((a, b) => (a.placement ?? 999) - (b.placement ?? 999));

  return html`
    <div class="pub">
      ${raw(navBar(tournament, null))}
      <main class="pub-main" style="max-width:1000px">
        <div class="row-between wrap mb-3" style="gap:14px">
          <div>
            <div class="row small muted gap-sm mb-1">
              <a href="/t/${esc(tournament?.slug || '')}/matches">Matches</a>
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
            ${raw(statusBadge(match.status))}
            ${raw(publicRoomBlock(match))}
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
      </main>
      ${raw(footer(tournament))}
    </div>`;
}

// ------------------------------------------------------------------ shared --
function matchCard(m, slug) {
  return `
    <div class="match-card ${m.status === 'live' ? 'live' : ''}" style="cursor:pointer"
         data-act="open" data-href="/t/match/${m.id}">
      <div class="row-between">
        <span style="font-weight:620">Match ${m.match_no}</span>
        ${statusBadge(m.status)}
      </div>
      <div class="row wrap small muted" style="gap:12px">
        <span>${icon('calendar', 13)} ${formatDate(m.scheduled_at)} ${formatTime(m.scheduled_at)}</span>
        ${m.map ? `<span>${esc(m.map)}</span>` : ''}
        ${m.group_name ? `<span>${esc(m.group_name)}</span>` : ''}
      </div>
      ${m.room_id ? `<div class="credentials tiny">${icon('key', 12)} ${esc(m.room_id)} / ${esc(m.room_password || '--')}</div>` : ''}
    </div>`;
}

function publicRoom(m) {
  if (m.room_id) return `<span class="credentials tiny">${esc(m.room_id)} / ${esc(m.room_password || '--')}</span>`;
  if (m.credentials?.reveal_at) return `<span class="locked tiny">${icon('lock', 12)} ${formatTime(m.credentials.reveal_at)}</span>`;
  return '<span class="dim">--</span>';
}

function publicRoomBlock(match) {
  if (match.room_id) {
    return `<div class="credentials">${icon('key', 14)} Room ${esc(match.room_id)} · ${esc(match.room_password || '--')}</div>`;
  }
  if (match.credentials?.reveal_at) {
    return `<div class="locked small">${icon('lock', 13)} Room details at ${formatTime(match.credentials.reveal_at)}</div>`;
  }
  return '';
}

const footer = (tournament) => `
  <footer class="pub-foot">
    ${tournament ? `${esc(tournament.name)} · ` : ''}Powered by Tournament Manager
  </footer>`;

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item) || 'Other';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

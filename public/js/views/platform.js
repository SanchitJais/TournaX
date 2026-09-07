/** Platform landing page and tournament discovery. */
import { api, qs } from '../lib/api.js';
import { $, debounce, delegate, esc, html, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { emptyState, formatDate, num, points, rankPill, teamLogo } from '../lib/ui.js';
import { bindShare, shareButton } from '../lib/share.js';
import { platformNav, platformFooter } from './chrome.js';

const FILTER_KEYS = ['search', 'game', 'status', 'format', 'region', 'organizer', 'from', 'to', 'mine'];

export default {
  title: (data) => (data?.kind === 'home' ? 'Esports Tournaments' : 'Browse Tournaments'),

  async load(ctx) {
    if (ctx.route?.key === 'home') {
      const [home, me] = await Promise.all([
        api.get('/api/discover/home'),
        ctx.state.user ? api.get('/api/me').catch(() => null) : Promise.resolve(null),
      ]);
      return { kind: 'home', ...home, me };
    }

    if (ctx.route?.key === 'teams') {
      const search = ctx.query.search || '';
      const list = await api.get(`/api/squads${qs({ search, game: ctx.query.game || '' })}`);
      return { kind: 'teams', search, squads: list.squads };
    }

    const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, ctx.query[k] || '']));
    const [list, meta] = await Promise.all([
      api.get(`/api/discover${qs(filters)}`),
      api.get('/api/discover/filters'),
    ]);
    return { kind: 'discover', filters, ...list, meta };
  },

  render(data, ctx) {
    if (data.kind === 'home') return homeMarkup(data, ctx);
    if (data.kind === 'teams') return teamsMarkup(data, ctx);
    return discoverMarkup(data, ctx);
  },

  mounted(data, ctx, root) {
    bindShare(root);

    if (data.kind === 'teams') {
      const box = $('#teams-search', root);
      box?.addEventListener('input', debounce((e) => {
        ctx.navigate(`/teams${qs({ search: e.target.value.trim() })}`, { replace: true });
      }, 300));
      if (data.search && box) {
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      }
      return;
    }

    if (data.kind === 'discover') {
      const apply = (patch) => {
        const next = { ...data.filters, ...patch };
        ctx.navigate(`/tournaments${qs(next)}`, { replace: true });
      };

      const search = $('#discover-search', root);
      search?.addEventListener('input', debounce((e) => apply({ search: e.target.value.trim() }), 300));
      if (data.filters.search && search) {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
      }
      root.querySelectorAll('[data-filter]').forEach((el) => {
        el.addEventListener('change', () => apply({ [el.dataset.filter]: el.value }));
      });

      delegate(root, {
        'set-status': (el) => apply({ status: el.dataset.value }),
        clear: () => ctx.navigate('/tournaments'),
        mine: () => apply({ mine: data.filters.mine ? '' : '1' }),
      });
    }
  },
};

// ------------------------------------------------------------------- home --
function homeMarkup(data, ctx) {
  const { counts, featured, leaderboards, me } = data;
  const signedIn = Boolean(ctx.state.user);

  return html`
    <div class="pub">
      ${raw(platformNav(ctx, 'home'))}
      <main class="pub-main">
        <section class="hero mb-3">
          <span class="badge badge-info mb-2">${counts.live ? raw('<span class="dot"></span>') : ''}
            ${counts.live ? `${counts.live} tournament(s) live now` : 'Esports tournament platform'}</span>
          <h1>Run a tournament.<br>Everything else is automated.</h1>
          <p class="mt-2">
            Fixtures, points, rankings, qualification and the next round are all worked out for you.
            Players register with their team, check in, and follow every match from one place.
          </p>
          <div class="row mt-3 wrap">
            <a class="btn btn-primary btn-lg" href="/tournaments">${raw(icon('trophy', 16))} Browse tournaments</a>
            ${signedIn
              ? raw(`<a class="btn btn-lg" href="/me">${icon('dashboard', 16)} My dashboard</a>`)
              : raw(`<a class="btn btn-lg" href="/login">${icon('users', 16)} Create an account</a>`)}
          </div>
          <div class="hero-stats">
            ${raw([
              ['Tournaments', counts.tournaments],
              ['Registration open', counts.registering],
              ['Teams', counts.teams],
              ['Players', counts.players],
              ['Matches played', counts.matches_played],
            ].map(([label, value]) => `
              <div class="hero-stat"><b>${num(value)}</b><span>${esc(label)}</span></div>`).join(''))}
          </div>
        </section>

        ${me && !me.profile_complete ? raw(`
          <div class="warn-box mb-3">
            ${icon('alert', 16)}
            <div class="grow">Your player profile is incomplete, so you cannot be registered for a tournament yet.</div>
            <a class="btn btn-sm" href="/me/profile">Complete profile</a>
          </div>`) : ''}

        <div class="row-between mb-2">
          <h2>Featured tournaments</h2>
          <a class="btn btn-ghost btn-sm" href="/tournaments">View all</a>
        </div>
        ${featured.length ? raw(`<div class="grid grid-auto mb-3">${featured.map(featuredCard).join('')}</div>`)
          : raw(emptyState({ icon: 'trophy', title: 'No tournaments published yet' }))}

        <div class="grid grid-2">
          ${raw(boardCard('Top teams', leaderboards.teams, (t) => `
            <td>${teamLogo(t, 'sm')}</td>
            <td><a href="/team/${esc(t.slug)}" style="font-weight:600">${esc(t.name)}</a>
                <div class="tiny dim">${esc(t.game)} · ${t.matches} matches</div></td>
            <td class="num dim small">${t.kills} K</td>
            <td class="num strong">${points(t.points)}</td>`))}
          ${raw(boardCard('Top killers', leaderboards.players, (p) => `
            <td>${avatar(p)}</td>
            <td><a href="/player/${p.user_id}" style="font-weight:600">${esc(p.ign || p.name)}</a>
                <div class="tiny dim">${esc(p.country || '')}</div></td>
            <td class="num dim small">${p.matches} m</td>
            <td class="num strong">${p.kills}</td>`,
          'Individual kill data appears once organizers record per-player stats.'))}
        </div>
      </main>
      ${raw(platformFooter())}
    </div>`;
}

const avatar = (p) => (p.avatar_url
  ? `<span class="player-avatar"><img src="${esc(p.avatar_url)}" alt="" style="width:100%;height:100%;object-fit:cover"></span>`
  : `<span class="player-avatar">${esc((p.ign || p.name || '?').slice(0, 2).toUpperCase())}</span>`);

function boardCard(title, rows, renderRow, emptyHint) {
  return `
    <div class="card">
      <div class="card-head"><h2>${esc(title)}</h2></div>
      <div class="card-body tight">
        ${rows?.length ? `
          <table class="data compact"><tbody>
            ${rows.map((row, i) => `<tr><td style="width:44px">${rankPill(i + 1)}</td>${renderRow(row)}</tr>`).join('')}
          </tbody></table>`
        : `<div class="empty"><span class="small muted">${esc(emptyHint || 'No data yet.')}</span></div>`}
      </div>
    </div>`;
}

function featuredCard(t) {
  return `
    <a class="tournament-card" href="/tournament/${esc(t.slug)}">
      <div class="thumb">${t.banner_url ? `<img src="${esc(t.banner_url)}" alt="">` : ''}</div>
      <div style="padding:14px 15px">
        <div class="row-between" style="align-items:flex-start">
          <div class="grow" style="min-width:0">
            <div class="truncate" style="font-weight:650;font-size:15px">${esc(t.name)}</div>
            <div class="tiny dim">${esc(t.game)}</div>
          </div>
          ${t.status === 'live' ? '<span class="live-pill"><span class="dot"></span>Live</span>' : ''}
        </div>
        <div class="row mt-2 small muted wrap" style="gap:14px">
          <span>${icon('teams', 13)} ${t.team_count} teams</span>
          ${t.prize_pool ? `<span>${icon('trophy', 13)} ${esc(t.prize_pool)}</span>` : ''}
          ${t.start_date ? `<span>${icon('calendar', 13)} ${formatDate(t.start_date)}</span>` : ''}
        </div>
        ${t.registration_open ? '<div class="badge badge-qualified mt-2">Registration open</div>' : ''}
      </div>
    </a>`;
}

// ------------------------------------------------------------ team browse --
function teamsMarkup(data, ctx) {
  const { squads, search } = data;
  return html`
    <div class="pub">
      ${raw(platformNav(ctx, 'teams'))}
      <main class="pub-main">
        <div class="page-head">
          <div class="page-title">
            <h1>Teams</h1>
            <p class="muted small" style="margin:0">${squads.length} team(s) on the platform.</p>
          </div>
          ${ctx.state.user ? raw('<a class="btn btn-primary" href="/me/teams">Create a team</a>') : ''}
        </div>

        <div class="card mb-3">
          <div class="card-body">
            <div class="search" style="max-width:none">
              ${raw(icon('search'))}
              <input class="input" id="teams-search" placeholder="Search teams by name or tag" value="${search}">
            </div>
          </div>
        </div>

        ${squads.length ? raw(`
          <div class="grid grid-auto">
            ${squads.map((s) => `
              <a class="card" href="/team/${esc(s.slug)}" style="display:block">
                <div class="card-body">
                  <div class="row" style="gap:11px">
                    ${teamLogo(s, 'lg')}
                    <div class="grow" style="min-width:0">
                      <div class="truncate" style="font-weight:650">${esc(s.name)}</div>
                      <div class="tiny dim">${esc(s.game)}${s.region ? ` · ${esc(s.region)}` : ''}</div>
                    </div>
                    ${s.tag ? `<span class="badge badge-neutral">${esc(s.tag)}</span>` : ''}
                  </div>
                  <div class="row mt-2 small muted" style="gap:14px">
                    <span>${icon('teams', 13)} ${s.member_count} player(s)</span>
                    <span>${icon('trophy', 13)} ${s.tournament_count} tournament(s)</span>
                  </div>
                </div>
              </a>`).join('')}
          </div>`)
        : raw(emptyState({
          icon: 'teams',
          title: search ? 'No teams match that search' : 'No teams yet',
          message: 'Teams appear here as players create them.',
        }))}
      </main>
      ${raw(platformFooter())}
    </div>`;
}

// --------------------------------------------------------------- discover --
function discoverMarkup(data, ctx) {
  const { tournaments, filters, meta } = data;
  const signedIn = Boolean(ctx.state.user);

  return html`
    <div class="pub">
      ${raw(platformNav(ctx, 'tournaments'))}
      <main class="pub-main">
        <div class="page-head">
          <div class="page-title">
            <h1>Tournaments</h1>
            <p class="muted small" style="margin:0">${tournaments.length} tournament(s) found.</p>
          </div>
          ${signedIn ? raw(`
            <button class="btn ${filters.mine ? 'btn-primary' : ''}" data-act="mine">
              ${icon('trophy', 15)} My tournaments
            </button>`) : ''}
        </div>

        <div class="card mb-3">
          <div class="card-body">
            <div class="row wrap" style="gap:10px">
              <div class="search" style="flex:1 1 260px;max-width:none">
                ${raw(icon('search'))}
                <input class="input" id="discover-search" placeholder="Search tournaments" value="${filters.search}">
              </div>
              ${raw(select('game', 'All games', meta.games.map((g) => [g, g]), filters.game))}
              ${raw(select('format', 'All formats', Object.entries(meta.formats), filters.format))}
              ${raw(select('region', 'All regions', meta.regions.map((r) => [r, r]), filters.region))}
              ${raw(select('organizer', 'All organizers', meta.organizers.map((o) => [o, o]), filters.organizer))}
            </div>
            <div class="row wrap mt-2" style="gap:10px">
              <div class="row gap-sm wrap">
                ${raw([['', 'All'], ...meta.statuses.map((s) => [s.value, s.label])].map(([value, label]) => `
                  <button class="chip ${filters.status === value ? 'active' : ''}" data-act="set-status" data-value="${value}">
                    ${esc(label)}</button>`).join(''))}
              </div>
              <div class="grow"></div>
              <div class="row gap-sm">
                <input class="input input-sm" type="date" data-filter="from" value="${filters.from}" title="From date">
                <input class="input input-sm" type="date" data-filter="to" value="${filters.to}" title="To date">
                ${raw(Object.values(filters).some(Boolean)
                  ? '<button class="btn btn-sm" data-act="clear">Clear</button>' : '')}
              </div>
            </div>
          </div>
        </div>

        ${tournaments.length
          ? raw(`<div class="grid grid-auto">${tournaments.map(discoverCard).join('')}</div>`)
          : raw(emptyState({
            icon: 'search',
            title: 'No tournaments match those filters',
            message: 'Try clearing a filter, or check back when new events are published.',
            action: '<button class="btn mt-2" data-act="clear">Clear filters</button>',
          }))}
      </main>
      ${raw(platformFooter())}
    </div>`;
}

const select = (key, placeholder, options, value) => `
  <select class="select input-sm" data-filter="${key}" style="width:auto;min-width:130px">
    <option value="">${esc(placeholder)}</option>
    ${options.map(([v, label]) => `<option value="${esc(v)}" ${value === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}
  </select>`;

function discoverCard(t) {
  const slots = t.slots || t.num_teams || 0;
  const pct = slots ? Math.min(100, Math.round((t.registered / slots) * 100)) : 0;

  return `
    <div class="tournament-card">
      <a href="/tournament/${esc(t.slug)}" style="display:block">
        <div class="thumb">
          ${t.banner_url ? `<img src="${esc(t.banner_url)}" alt="">` : ''}
          ${t.status === 'live' ? '<span class="live-pill" style="position:absolute;top:10px;left:10px"><span class="dot"></span>Live</span>' : ''}
        </div>
        <div style="padding:14px 15px">
          <div class="row-between" style="align-items:flex-start;gap:8px">
            <div class="grow" style="min-width:0">
              <div class="truncate" style="font-weight:650;font-size:15px">${esc(t.name)}</div>
              <div class="tiny dim">${esc(t.game)}${t.organizer ? ` · by ${esc(t.organizer)}` : ''}</div>
            </div>
            ${t.registration_open
              ? '<span class="badge badge-qualified">Open</span>'
              : `<span class="badge badge-${t.status === 'live' ? 'live' : 'neutral'}">${esc(t.status)}</span>`}
          </div>

          <div class="row mt-2 small muted wrap" style="gap:13px">
            ${t.prize_pool ? `<span>${icon('trophy', 13)} ${esc(t.prize_pool)}</span>` : ''}
            ${t.start_date ? `<span>${icon('calendar', 13)} ${formatDate(t.start_date, { withYear: true })}</span>` : ''}
            ${t.region ? `<span>${esc(t.region)}</span>` : ''}
          </div>

          ${slots ? `
            <div class="mt-2">
              <div class="row-between tiny dim mb-1">
                <span>${t.registered} / ${slots} teams registered</span><span>${pct}%</span>
              </div>
              <div class="slots-bar"><span style="width:${pct}%"></span></div>
            </div>` : ''}
        </div>
      </a>
      <div class="row-between" style="padding:10px 15px;border-top:1px solid var(--border-soft)">
        <a class="btn btn-sm ${t.registration_open ? 'btn-primary' : ''}"
           href="/tournament/${esc(t.slug)}${t.registration_open ? '/register' : ''}">
          ${t.registration_open ? 'Register' : 'View tournament'}
        </a>
        ${shareButton(`/tournament/${t.slug}`)}
      </div>
    </div>`;
}

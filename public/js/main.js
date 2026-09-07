/**
 * App shell: routing, the admin chrome, and session bootstrap.
 *
 * Views are plain modules exporting { title, load, render, mounted }, which
 * keeps each screen independent and testable in the browser console.
 */
import { api, setUnauthorizedHandler } from './lib/api.js';
import { $, delegate, esc, html, mount, raw } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { emptyState, toast, toastError } from './lib/ui.js';

import authView from './views/auth.js';
import adminHome from './views/adminHome.js';
import wizard from './views/wizard.js';
import dashboard from './views/dashboard.js';
import teamsView from './views/teams.js';
import fixturesView from './views/fixtures.js';
import matchesView from './views/matches.js';
import matchDetail from './views/matchDetail.js';
import leaderboardView from './views/leaderboard.js';
import qualificationView from './views/qualification.js';
import settingsView from './views/settings.js';
import peopleView from './views/people.js';
import activityView from './views/activity.js';
import publicSite from './views/publicSite.js';

// ---------------------------------------------------------------- app state --
export const state = {
  user: null,
  tournament: null,
  tournamentId: null,
  abilities: {},
  role: 'spectator',
  unread: 0,
  route: null,
};

// ------------------------------------------------------------------ routing --
const ROUTES = [
  { path: '/login', view: authView, chrome: 'none' },
  { path: '/register', view: authView, chrome: 'none' },

  { path: '/admin', view: adminHome, chrome: 'plain' },
  { path: '/admin/new', view: wizard, chrome: 'plain' },
  { path: '/admin/users', view: peopleView, chrome: 'plain', key: 'users' },
  { path: '/admin/templates', view: settingsView, chrome: 'plain', key: 'templates' },

  { path: '/admin/t/:id', view: dashboard, chrome: 'admin', key: 'dashboard' },
  { path: '/admin/t/:id/teams', view: teamsView, chrome: 'admin', key: 'teams' },
  { path: '/admin/t/:id/fixtures', view: fixturesView, chrome: 'admin', key: 'fixtures' },
  { path: '/admin/t/:id/matches', view: matchesView, chrome: 'admin', key: 'matches' },
  { path: '/admin/t/:id/matches/:matchId', view: matchDetail, chrome: 'admin', key: 'matches' },
  { path: '/admin/t/:id/leaderboard', view: leaderboardView, chrome: 'admin', key: 'leaderboard' },
  { path: '/admin/t/:id/qualification', view: qualificationView, chrome: 'admin', key: 'qualification' },
  { path: '/admin/t/:id/activity', view: activityView, chrome: 'admin', key: 'activity' },
  { path: '/admin/t/:id/people', view: peopleView, chrome: 'admin', key: 'people' },
  { path: '/admin/t/:id/settings', view: settingsView, chrome: 'admin', key: 'settings' },

  { path: '/', view: publicSite, chrome: 'public', key: 'browse' },
  { path: '/t/match/:matchId', view: publicSite, chrome: 'public', key: 'match' },
  { path: '/t/:slug', view: publicSite, chrome: 'public', key: 'home' },
  { path: '/t/:slug/:section', view: publicSite, chrome: 'public', key: 'section' },
];

const compiled = ROUTES.map((route) => {
  const names = [];
  const source = route.path
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z_]\w*)/g, (_, name) => { names.push(name); return '([^/]+)'; });
  return { ...route, regex: new RegExp(`^${source}/?$`), names };
});

function matchRoute(pathname) {
  for (const route of compiled) {
    const m = route.regex.exec(pathname);
    if (!m) continue;
    return { route, params: Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

export function navigate(path, { replace = false } = {}) {
  if (path === location.pathname + location.search) return renderRoute();
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  renderRoute();
}

window.addEventListener('popstate', () => renderRoute());

// Any in-app link goes through the router instead of reloading the page.
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href^="/"]');
  if (!link || link.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey) return;
  if (link.hasAttribute('download') || link.dataset.native === 'true') return;
  e.preventDefault();
  navigate(link.getAttribute('href'));
});

// ------------------------------------------------------------------- chrome --
const NAV_SECTIONS = [
  {
    heading: 'Manage',
    items: [
      { key: 'dashboard', label: 'Dashboard', icon: 'dashboard', to: '' },
      { key: 'teams', label: 'Teams', icon: 'teams', to: '/teams' },
      { key: 'fixtures', label: 'Fixtures', icon: 'calendar', to: '/fixtures' },
      { key: 'matches', label: 'Match Center', icon: 'play', to: '/matches' },
    ],
  },
  {
    heading: 'Standings',
    items: [
      { key: 'leaderboard', label: 'Leaderboard', icon: 'trophy', to: '/leaderboard' },
      { key: 'qualification', label: 'Qualification', icon: 'target', to: '/qualification' },
    ],
  },
  {
    heading: 'Tournament',
    items: [
      { key: 'activity', label: 'Activity', icon: 'bell', to: '/activity', badge: 'unread' },
      { key: 'people', label: 'Access', icon: 'users', to: '/people' },
      { key: 'settings', label: 'Settings', icon: 'settings', to: '/settings' },
    ],
  },
];

function renderSidebar(activeKey) {
  const base = `/admin/t/${state.tournamentId}`;
  const t = state.tournament;
  const sections = NAV_SECTIONS.map((section) => html`
    <div class="side-heading">${section.heading}</div>
    ${raw(section.items.map((item) => {
      const badge = item.badge === 'unread' && state.unread
        ? `<span class="nav-badge">${state.unread}</span>` : '';
      return `<a class="nav-item ${item.key === activeKey ? 'active' : ''}" href="${base}${item.to}">
                ${icon(item.icon)}<span class="grow">${esc(item.label)}</span>${badge}
              </a>`;
    }).join(''))}
  `).join('');

  return html`
    <aside class="sidebar" id="sidebar">
      <a class="brand" href="/admin">
        <span class="brand-mark">TM</span>
        <span class="grow truncate">
          <div class="brand-name truncate">${t?.name || 'Tournament'}</div>
          <div class="brand-sub">${t?.game || 'Manager'}</div>
        </span>
      </a>
      <div class="side-scroll">
        <a class="nav-item" href="/admin">${raw(icon('layers'))}<span class="grow">All tournaments</span></a>
        ${raw(sections)}
        <div class="side-heading">View</div>
        <a class="nav-item" href="/t/${t?.slug || ''}" data-native="true" target="_blank">
          ${raw(icon('external'))}<span class="grow">Public page</span>
        </a>
      </div>
      ${raw(renderUserChip())}
    </aside>`;
}

function renderUserChip() {
  if (!state.user) {
    return `<div class="side-foot"><a class="btn btn-primary btn-block" href="/login">Sign in</a></div>`;
  }
  const roleLabel = {
    super_admin: 'Super Admin', tournament_admin: 'Tournament Admin',
    scorekeeper: 'Scorekeeper', team_manager: 'Team Manager', spectator: 'Spectator',
  }[state.role] || state.role;
  return html`
    <div class="side-foot">
      <div class="user-chip">
        <span class="avatar">${esc((state.user.name || '?').slice(0, 2).toUpperCase())}</span>
        <span class="grow truncate">
          <div class="truncate" style="font-weight:600;font-size:13px">${state.user.name}</div>
          <div class="tiny dim truncate">${roleLabel}</div>
        </span>
        <button class="btn btn-ghost btn-icon" data-act="logout" title="Sign out">${raw(icon('logout', 15))}</button>
      </div>
    </div>`;
}

const shellMarkup = (activeKey) => html`
  <div class="app">
    ${raw(renderSidebar(activeKey))}
    <div class="main">
      <header class="topbar">
        <button class="btn btn-ghost btn-icon burger" data-act="toggle-sidebar" aria-label="Menu">${raw(icon('menu'))}</button>
        <div class="grow" id="topbar-slot"></div>
      </header>
      <div id="view"></div>
    </div>
  </div>`;

const plainShell = () => html`
  <div class="app">
    <div class="main">
      <header class="topbar">
        <a class="row" href="/admin" style="gap:10px">
          <span class="brand-mark">TM</span>
          <span>
            <div class="brand-name">Tournament Manager</div>
            <div class="brand-sub">Fixture automation</div>
          </span>
        </a>
        <div class="grow"></div>
        ${state.user ? raw(`
          <a class="btn btn-ghost btn-sm" href="/">Public site</a>
          <span class="avatar" title="${esc(state.user.name)}">${esc((state.user.name || '?').slice(0, 2).toUpperCase())}</span>
          <button class="btn btn-ghost btn-icon" data-act="logout" title="Sign out">${icon('logout', 15)}</button>
        `) : raw('<a class="btn btn-primary btn-sm" href="/login">Sign in</a>')}
      </header>
      <div id="view"></div>
    </div>
  </div>`;

// ------------------------------------------------------------------ render ---
let currentChrome = null;
let currentKey = null;
let renderToken = 0;

async function renderRoute() {
  const token = ++renderToken;
  const matched = matchRoute(location.pathname);

  if (!matched) {
    mount('#app', notFoundMarkup());
    return;
  }

  const { route, params } = matched;
  const ctx = { params, query: Object.fromEntries(new URLSearchParams(location.search)), navigate, state };
  state.route = route;

  // Admin screens need the tournament and the caller's abilities loaded first.
  if (route.chrome === 'admin') {
    if (!state.user) { navigate('/login', { replace: true }); return; }
    const id = Number(params.id);
    if (state.tournamentId !== id || !state.tournament) {
      try {
        const [bundle, abilities] = await Promise.all([
          api.get(`/api/tournaments/${id}`),
          api.get(`/api/tournaments/${id}/abilities`),
        ]);
        if (token !== renderToken) return;
        state.tournamentId = id;
        state.tournament = bundle.tournament;
        state.bundle = bundle;
        state.abilities = abilities.abilities;
        state.role = abilities.role;
      } catch (err) {
        mount('#app', plainShell());
        mount('#view', `<div class="page">${emptyState({
          icon: 'alert', title: 'Tournament unavailable', message: err.message,
          action: '<a class="btn btn-primary mt-2" href="/admin">Back to tournaments</a>',
        })}</div>`);
        bindShell();
        return;
      }
    }
  }

  // Rebuild the chrome only when it actually changes, so navigation is snappy.
  const chromeKey = `${route.chrome}:${route.chrome === 'admin' ? state.tournamentId : ''}:${route.key}`;
  if (currentChrome !== chromeKey) {
    if (route.chrome === 'admin') mount('#app', shellMarkup(route.key));
    else if (route.chrome === 'plain') mount('#app', plainShell());
    else if (route.chrome === 'public') mount('#app', '<div id="view"></div>');
    else mount('#app', '<div id="view"></div>');
    currentChrome = chromeKey;
    bindShell();
  } else if (route.chrome === 'admin' && currentKey !== route.key) {
    // Same tournament, different section: just move the active nav item.
    document.querySelectorAll('.sidebar .nav-item').forEach((el) => el.classList.remove('active'));
    const base = `/admin/t/${state.tournamentId}`;
    const item = NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.key === route.key);
    if (item) document.querySelector(`.sidebar a[href="${base}${item.to}"]`)?.classList.add('active');
  }
  currentKey = route.key;

  const host = $('#view');
  host.innerHTML = '<div class="page"><div class="skeleton" style="height:120px"></div></div>';

  try {
    const data = route.view.load ? await route.view.load(ctx) : null;
    if (token !== renderToken) return;
    host.innerHTML = route.view.render(data, ctx);
    route.view.mounted?.(data, ctx, host);
    document.title = route.view.title
      ? `${typeof route.view.title === 'function' ? route.view.title(data, ctx) : route.view.title} - Tournament Manager`
      : 'Tournament Manager';
    window.scrollTo({ top: 0 });
    $('#sidebar')?.classList.remove('open');
    $('.scrim')?.remove();
  } catch (err) {
    if (token !== renderToken) return;
    console.error(err);
    host.innerHTML = `<div class="page">${emptyState({
      icon: 'alert', title: 'Could not load this page', message: err.message,
      action: '<button class="btn mt-2" onclick="location.reload()">Reload</button>',
    })}</div>`;
  }
}

function bindShell() {
  delegate('#app', {
    logout: async () => {
      await api.post('/api/auth/logout');
      state.user = null;
      state.tournament = null;
      state.tournamentId = null;
      currentChrome = null;
      toast('Signed out.');
      navigate('/login');
    },
    'toggle-sidebar': () => {
      const bar = $('#sidebar');
      if (!bar) return;
      const open = bar.classList.toggle('open');
      $('.scrim')?.remove();
      if (open) {
        const scrim = document.createElement('div');
        scrim.className = 'scrim';
        scrim.addEventListener('click', () => { bar.classList.remove('open'); scrim.remove(); });
        document.body.appendChild(scrim);
      }
    },
  });
}

const notFoundMarkup = () => html`
  <div class="page" style="max-width:520px;margin:80px auto">
    ${raw(emptyState({
      icon: 'alert',
      title: 'Page not found',
      message: 'That address does not match anything in the app.',
      action: '<a class="btn btn-primary mt-2" href="/">Go home</a>',
    }))}
  </div>`;

/** Refresh the unread badge without a full re-render. */
export async function refreshUnread() {
  if (!state.tournamentId) return;
  try {
    const { unread } = await api.get(`/api/tournaments/${state.tournamentId}/notifications?limit=1`);
    state.unread = unread;
    const item = document.querySelector('.sidebar a[href$="/activity"]');
    if (!item) return;
    item.querySelector('.nav-badge')?.remove();
    if (unread) item.insertAdjacentHTML('beforeend', `<span class="nav-badge">${unread}</span>`);
  } catch { /* the badge is cosmetic */ }
}

/** Drop cached tournament data so the next navigation refetches it. */
export function invalidateTournament() {
  state.tournament = null;
  state.tournamentId = null;
  currentChrome = null;
}

export const can = (ability) => Boolean(state.abilities?.[ability]);

// -------------------------------------------------------------- bootstrap ---
setUnauthorizedHandler(() => {
  if (location.pathname.startsWith('/admin')) {
    state.user = null;
    currentChrome = null;
    navigate('/login', { replace: true });
  }
});

(async function boot() {
  try {
    const me = await api.get('/api/auth/me');
    state.user = me.user;
    state.role = me.user?.role || 'spectator';
  } catch {
    state.user = null;
  }
  await renderRoute();
})();

export { renderRoute, toastError };

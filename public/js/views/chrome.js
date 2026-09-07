/** Shared public-site chrome: top navigation, global search, footer. */
import { api } from '../lib/api.js';
import { $, debounce, esc, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

const LINKS = [
  ['home', 'Home', '/'],
  ['tournaments', 'Tournaments', '/tournaments'],
  ['teams', 'Teams', '/teams'],
];

/** Top bar for every public / player-facing page. */
export function platformNav(ctx, active) {
  const user = ctx?.state?.user;
  return `
    <nav class="pub-nav">
      <a class="row" href="/" style="gap:10px;flex-shrink:0">
        <span class="brand-mark" style="width:30px;height:30px;font-size:13px">TM</span>
        <span style="font-weight:700">Tournament Manager</span>
      </a>

      <div class="pub-links">
        ${LINKS.map(([key, label, href]) => `
          <a class="pub-link ${active === key ? 'active' : ''}" href="${href}">${esc(label)}</a>`).join('')}
      </div>

      <div class="gsearch" id="global-search">
        ${icon('search')}
        <input class="input input-sm" id="global-search-input" placeholder="Search teams, players, tournaments"
               autocomplete="off" aria-label="Search">
      </div>

      <div class="row gap-sm" style="flex-shrink:0">
        ${user ? `
          <a class="btn btn-ghost btn-sm" href="/me">${icon('dashboard', 14)} Dashboard</a>
          <a class="btn btn-ghost btn-sm" href="/admin" title="Organizer area">${icon('settings', 14)}</a>
          <a href="/me" class="avatar" title="${esc(user.name)}" style="width:28px;height:28px;flex-basis:28px;font-size:11px">
            ${esc((user.name || '?').slice(0, 2).toUpperCase())}</a>
        ` : `
          <a class="btn btn-ghost btn-sm" href="/login">Sign in</a>
          <a class="btn btn-primary btn-sm" href="/register">Join</a>
        `}
      </div>
    </nav>`;
}

export const platformFooter = (extra = '') => `
  <footer class="pub-foot">
    ${extra ? `${esc(extra)} · ` : ''}Tournament Manager — create a tournament, enter the teams, everything else is automated.
  </footer>`;

/**
 * Wire the global search box. Results come from /api/search and are keyboard
 * navigable; bound once per rendered nav.
 */
export function bindGlobalSearch(root) {
  const box = $('#global-search', root);
  const input = $('#global-search-input', root);
  if (!box || !input || box.dataset.bound === '1') return;
  box.dataset.bound = '1';

  let results = [];
  let cursor = -1;
  let panel = null;

  const close = () => { panel?.remove(); panel = null; cursor = -1; };

  const draw = () => {
    close();
    panel = document.createElement('div');
    panel.className = 'gsearch-results';
    panel.innerHTML = results.length
      ? results.map((r, i) => `
          <a class="gsearch-item ${i === cursor ? 'active' : ''}" href="${esc(r.href)}" data-index="${i}">
            <span class="gsearch-kind">${esc(r.kind)}</span>
            <span class="grow" style="min-width:0">
              <div class="truncate" style="font-weight:600">${esc(r.title)}</div>
              ${r.subtitle ? `<div class="tiny dim truncate">${esc(r.subtitle)}</div>` : ''}
            </span>
          </a>`).join('')
      : '<div class="gsearch-empty">No matches found.</div>';
    box.appendChild(panel);
  };

  const search = debounce(async (term) => {
    if (term.length < 2) { results = []; close(); return; }
    try {
      const res = await api.get(`/api/search?q=${encodeURIComponent(term)}`);
      results = res.results || [];
      cursor = -1;
      draw();
    } catch { close(); }
  }, 220);

  input.addEventListener('input', (e) => search(e.target.value.trim()));
  input.addEventListener('focus', () => { if (results.length) draw(); });

  input.addEventListener('keydown', (e) => {
    if (!results.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = e.key === 'ArrowDown'
        ? (cursor + 1) % results.length
        : (cursor - 1 + results.length) % results.length;
      draw();
    } else if (e.key === 'Enter' && cursor >= 0) {
      e.preventDefault();
      const target = results[cursor];
      close();
      input.value = '';
      results = [];
      document.querySelector('#app')?.dispatchEvent(new CustomEvent('navigate', { detail: target.href, bubbles: true }));
      history.pushState({}, '', target.href);
      window.dispatchEvent(new PopStateEvent('popstate'));
    } else if (e.key === 'Escape') {
      close();
      input.blur();
    }
  });

  document.addEventListener('click', (e) => {
    if (!box.contains(e.target)) close();
  });
}

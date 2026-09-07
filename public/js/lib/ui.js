/** Shared UI pieces: toasts, modals, confirmations, badges, charts. */
import { $, delegate, esc, html, initials, mount, raw } from './dom.js';
import { icon } from './icons.js';

// ------------------------------------------------------------------ toasts --
let toastHost;
export function toast(message, { type = 'info', title = null, timeout = 4200 } = {}) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    document.body.appendChild(toastHost);
  }
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  const glyph = type === 'success' ? 'check' : type === 'error' ? 'alert' : 'info';
  node.innerHTML = html`
    <span class="toast-ico">${raw(icon(glyph, 17))}</span>
    <div class="grow">
      ${title ? raw(`<div class="toast-title">${esc(title)}</div>`) : ''}
      <div class="${title ? 'toast-body' : 'toast-title'}">${message}</div>
    </div>`;
  toastHost.appendChild(node);

  const dismiss = () => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  };
  node.addEventListener('click', dismiss);
  if (timeout) setTimeout(dismiss, timeout);
  return dismiss;
}

export const toastError = (err) =>
  toast(err?.message || String(err), { type: 'error', title: 'That did not work' });

// ------------------------------------------------------------------ modals --
let openModal = null;

/**
 * Show a modal. `render` returns body HTML; `onMount` receives the modal
 * element so a view can wire up its own listeners.
 */
export function modal({ title, body, footer = '', size = '', onMount, onClose }) {
  closeModal();

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = html`
    <div class="modal ${raw(size)}" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal-head">
        <h2>${title}</h2>
        <button class="btn btn-ghost btn-icon" data-modal-close aria-label="Close">${raw(icon('close', 16))}</button>
      </div>
      <div class="modal-body">${raw(typeof body === 'function' ? body() : body)}</div>
      ${footer ? raw(`<div class="modal-foot">${footer}</div>`) : ''}
    </div>`;

  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  const close = () => {
    if (openModal !== state) return;
    overlay.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
    openModal = null;
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const state = { close, overlay };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('[data-modal-close]')) close();
  });
  document.addEventListener('keydown', onKey);
  openModal = state;

  onMount?.(overlay, close);
  const firstField = overlay.querySelector('input:not([type=hidden]), select, textarea');
  firstField?.focus();
  return state;
}

export function closeModal() {
  openModal?.close();
}

/** Destructive-action guard. Resolves true only when confirmed. */
export function confirmAction({
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  danger = true,
  detail = '',
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

    const state = modal({
      title,
      size: 'narrow',
      body: html`
        <p>${message}</p>
        ${detail ? raw(`<div class="warn-box mt-2">${icon('alert', 16)}<div>${esc(detail)}</div></div>`) : ''}`,
      footer: `
        <button class="btn" data-confirm-cancel>Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm-ok>${esc(confirmLabel)}</button>`,
      onMount(overlay, close) {
        overlay.querySelector('[data-confirm-ok]').addEventListener('click', () => { finish(true); close(); });
        overlay.querySelector('[data-confirm-cancel]').addEventListener('click', () => { finish(false); close(); });
      },
      onClose: () => finish(false),
    });
    return state;
  });
}

/** Wrap an async action with a button spinner and error toast. */
export async function withBusy(button, fn) {
  if (!button) return fn();
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span> ${button.dataset.busyLabel || 'Working'}`;
  try {
    return await fn();
  } catch (err) {
    toastError(err);
    throw err;
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

// ---------------------------------------------------------------- fragments --
export const statusBadge = (status) => {
  const label = { upcoming: 'Upcoming', live: 'Live', completed: 'Completed', cancelled: 'Cancelled' }[status] || status;
  const dot = status === 'live' ? '<span class="dot"></span>' : '';
  return `<span class="badge badge-${esc(status)}">${dot}${esc(label)}</span>`;
};

export const teamStatusBadge = (status) => {
  const label = { active: 'Active', qualified: 'Qualified', eliminated: 'Eliminated', withdrawn: 'Withdrawn' }[status] || status;
  return `<span class="badge badge-${esc(status)}">${esc(label)}</span>`;
};

/** Logo, or a coloured monogram when there is no image. */
export function teamLogo(team, size = '') {
  const cls = `team-logo ${size}`.trim();
  if (team?.logo_url) {
    return `<span class="${cls}"><img src="${esc(team.logo_url)}" alt="" width="100%" height="100%" style="object-fit:cover"></span>`;
  }
  return `<span class="${cls}">${esc(initials(team?.name || team?.team_name))}</span>`;
}

export function teamCell(team, { size = '', sub = null } = {}) {
  const name = team?.name || team?.team_name || 'Unknown team';
  return html`
    <span class="team-cell">
      ${raw(teamLogo(team, size))}
      <span class="grow truncate">
        <span class="team-name truncate">${name}</span>
        ${sub ? raw(`<span class="team-tag">${esc(sub)}</span>`) : (team?.tag ? raw(`<span class="team-tag">${esc(team.tag)}</span>`) : '')}
      </span>
    </span>`;
}

export const rankPill = (rank) =>
  `<span class="rank ${rank <= 3 ? `r${rank}` : ''}">${rank}</span>`;

export function movementIndicator(movement) {
  if (!movement) return '<span class="move flat">-</span>';
  const up = movement > 0;
  return `<span class="move ${up ? 'up' : 'down'}">${icon(up ? 'arrowUp' : 'arrowDown', 11)}${Math.abs(movement)}</span>`;
}

export function emptyState({ icon: glyph = 'info', title, message, action = '' }) {
  return html`
    <div class="empty">
      <div class="empty-ico">${raw(icon(glyph, 22))}</div>
      <h3>${title}</h3>
      ${message ? raw(`<p class="muted small" style="max-width:400px">${esc(message)}</p>`) : ''}
      ${raw(action)}
    </div>`;
}

export const skeletonRows = (rows = 5, cols = 4) =>
  Array.from({ length: rows }, () => `
    <tr>${Array.from({ length: cols }, () => '<td><div class="skeleton" style="height:14px"></div></td>').join('')}</tr>
  `).join('');

// -------------------------------------------------------------- formatting --
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Stored timestamps are naive local time ("2026-09-10 19:00"). */
export function parseStamp(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value, { withYear = false } = {}) {
  const d = parseStamp(value);
  if (!d) return '--';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${withYear ? `, ${d.getFullYear()}` : ''}`;
}

export function formatTime(value) {
  const d = parseStamp(value);
  if (!d) return '--';
  let hours = d.getHours();
  const suffix = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${hours}:${String(d.getMinutes()).padStart(2, '0')} ${suffix}`;
}

export const formatDateTime = (value) =>
  (parseStamp(value) ? `${formatDate(value)}, ${formatTime(value)}` : '--');

/** "3 minutes ago" / "in 2 hours" -- used by audit rows and countdowns. */
export function relativeTime(value, { assumeUtc = false } = {}) {
  const d = parseStamp(assumeUtc && value ? `${value}Z`.replace(' ', 'T') : value);
  if (!d) return '';
  const diff = Date.now() - d.getTime();
  const abs = Math.abs(diff);
  const units = [[86400000, 'day'], [3600000, 'hour'], [60000, 'minute'], [1000, 'second']];
  for (const [ms, name] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      const plural = n === 1 ? name : `${name}s`;
      return diff >= 0 ? `${n} ${plural} ago` : `in ${n} ${plural}`;
    }
  }
  return 'just now';
}

export const num = (value, decimals = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};

/** Points can be fractional; show a decimal only when there is one. */
export const points = (value) => {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
};

// ------------------------------------------------------------------ charts --
/**
 * Vertical bar chart as inline SVG -- no chart library required.
 *
 * Drawn in a fixed pixel-space viewBox and scaled uniformly. Stretching the
 * viewBox to fit (preserveAspectRatio="none") would distort the axis text.
 */
export function barChart(data, { height = 160, valueKey = 'value', labelKey = 'label', format = num } = {}) {
  if (!data?.length) return emptyState({ title: 'No data yet', message: 'Charts appear once matches are completed.' });

  const W = 600;
  const H = 220;
  const padL = 42;
  const padR = 10;
  const padT = 12;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const max = Math.max(...data.map((d) => Number(d[valueKey]) || 0), 1);
  const band = plotW / data.length;
  const barW = Math.max(2, Math.min(band * 0.68, 48));

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const y = padT + plotH - t * plotH;
    return `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>
            <text class="axis-label" x="${padL - 7}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${esc(format(max * t))}</text>`;
  }).join('');

  const bars = data.map((d, i) => {
    const value = Number(d[valueKey]) || 0;
    const h = (value / max) * plotH;
    const x = padL + i * band + (band - barW) / 2;
    const y = padT + plotH - h;
    return `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}"
              height="${Math.max(h, 1.5).toFixed(1)}" rx="2"><title>${esc(d[labelKey])}: ${esc(format(value))}</title></rect>`;
  }).join('');

  // Thin out the x labels rather than letting them collide.
  const stride = Math.ceil(data.length / 16);
  const labels = data.map((d, i) => (i % stride ? '' : `
      <text class="axis-label" x="${(padL + i * band + band / 2).toFixed(1)}" y="${H - 8}"
            text-anchor="middle">${esc(d[labelKey])}</text>`)).join('');

  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:${height * 1.5}px"
         role="img" aria-label="Bar chart">
      <defs>
        <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#9d85ff"/><stop offset="100%" stop-color="#22d3ee" stop-opacity="0.55"/>
        </linearGradient>
      </defs>
      ${gridLines}${bars}${labels}
    </svg>`;
}

/** Compact trend line for a single series. */
export function sparkline(values, { height = 40, stroke = '#7c5cff' } = {}) {
  if (!values?.length) return '';
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const points2 = values.map((v, i) => {
    const x = (i / Math.max(values.length - 1, 1)) * 100;
    const y = 30 - ((v - min) / span) * 26;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  return `
    <svg class="chart" viewBox="0 0 100 32" height="${height}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${points2}" fill="none" stroke="${stroke}" stroke-width="1.6"
                vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
}

export { $, delegate, esc, html, mount, raw };

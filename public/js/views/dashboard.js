/** Admin dashboard: headline numbers, quick actions and the workflow guide. */
import { api, download } from '../lib/api.js';
import { delegate, esc, html, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import {
  barChart, emptyState, formatDateTime, movementIndicator, num, points, rankPill,
  relativeTime, statusBadge, teamCell, toast, toastError,
} from '../lib/ui.js';
import { can, refreshUnread } from '../main.js';

export default {
  title: (data) => data?.tournament?.name || 'Dashboard',

  load: (ctx) => api.get(`/api/tournaments/${ctx.params.id}/dashboard`),

  render(data, ctx) {
    const { tournament, stats, standings, upcoming, recent, notifications, progress } = data;
    const base = `/admin/t/${tournament.id}`;

    return html`
      <div class="page">
        <div class="page-head">
          <div class="page-title">
            <h1>${tournament.name} ${raw(statusPill(tournament.status))}</h1>
            <p class="muted small" style="margin:0">
              ${tournament.game} · ${tournament.match_format}
              ${tournament.start_date ? ` · from ${tournament.start_date}` : ''}
            </p>
          </div>
          <div class="row wrap">
            <button class="btn" data-act="export">${raw(icon('download', 15))} Export</button>
            <a class="btn btn-ghost" href="/t/${esc(tournament.slug)}" data-native="true" target="_blank">
              ${raw(icon('external', 15))} Public page
            </a>
          </div>
        </div>

        ${raw(workflow(data, base))}

        <div class="grid grid-stats mt-3">
          ${raw(statCard('Total Teams', num(stats.teams), `${num(stats.still_in)} still in`))}
          ${raw(statCard('Matches', num(stats.matches), `${num(stats.upcoming)} upcoming`, 'accent'))}
          ${raw(statCard('Completed', num(stats.completed), stats.matches ? `${Math.round((stats.completed / stats.matches) * 100)}% played` : 'Not started'))}
          ${raw(statCard('Total Kills', num(stats.total_kills), `${stats.avg_kills_per_match} per match`, 'warn'))}
          ${raw(statCard('Qualified', num(stats.qualified), stats.qualified ? 'Cut locked' : 'Not locked yet'))}
          ${raw(leaderCard(stats.leader))}
        </div>

        <div class="grid grid-2 mt-3" style="grid-template-columns:minmax(0,1.35fr) minmax(0,1fr)">
          <div class="col" style="gap:16px">
            ${raw(quickActions(base))}
            ${raw(standingsCard(standings, base))}
          </div>
          <div class="col" style="gap:16px">
            ${raw(upcomingCard(upcoming, base))}
            ${raw(progressCard(progress))}
            ${raw(recentCard(recent, base))}
            ${raw(activityCard(notifications, base))}
          </div>
        </div>
      </div>`;
  },

  mounted(data, ctx, root) {
    refreshUnread();
    delegate(root, {
      export: () => exportMenu(data.tournament.id),
      'quick-generate': () => ctx.navigate(`/admin/t/${data.tournament.id}/fixtures`),
      async publish() {
        try {
          await api.patch(`/api/tournaments/${data.tournament.id}`, { status: 'live', is_public: true });
          toast('Tournament published. The public page is live.', { type: 'success' });
          ctx.navigate(`/admin/t/${data.tournament.id}`);
        } catch (err) { toastError(err); }
      },
    });
  },
};

// ------------------------------------------------------------------ pieces --
const statusPill = (status) => {
  const map = { live: 'badge-live', completed: 'badge-completed', draft: 'badge-draft', archived: 'badge-cancelled' };
  return `<span class="badge ${map[status] || 'badge-neutral'}" style="font-size:11px;vertical-align:middle">
            ${status === 'live' ? '<span class="dot"></span>' : ''}${esc(status)}</span>`;
};

const statCard = (label, value, meta, variant = '') => `
  <div class="stat ${variant}">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value">${esc(value)}</div>
    <div class="stat-meta">${esc(meta)}</div>
  </div>`;

const leaderCard = (leader) => `
  <div class="stat gold">
    <div class="stat-label">Current Leader</div>
    ${leader ? `
      <div class="row mt-1" style="gap:9px">
        ${teamCell({ name: leader.name, logo_url: leader.logo_url })}
      </div>
      <div class="stat-meta">${points(leader.points)} points</div>`
    : '<div class="stat-value">--</div><div class="stat-meta">No results yet</div>'}
  </div>`;

/**
 * The workflow strip doubles as guidance and as a nudge towards whatever the
 * organizer still needs to do.
 */
function workflow(data, base) {
  const { stats } = data;
  const steps = [
    { label: 'Tournament created', done: true },
    { label: `Teams added (${stats.teams})`, done: stats.teams > 0, href: `${base}/teams` },
    { label: `Fixtures generated (${stats.matches})`, done: stats.matches > 0, href: `${base}/fixtures` },
    { label: `Results entered (${stats.completed}/${stats.matches || 0})`, done: stats.completed > 0, href: `${base}/matches` },
    { label: 'Qualification locked', done: stats.qualified > 0, href: `${base}/qualification` },
  ];
  const currentIndex = steps.findIndex((s) => !s.done);

  return `
    <div class="card">
      <div class="card-body" style="padding:13px 15px">
        <div class="row-between wrap" style="gap:10px">
          <div class="steps">
            ${steps.map((step, i) => `
              <a class="step ${step.done ? 'done' : ''} ${i === currentIndex ? 'current' : ''}" href="${step.href || '#'}">
                <span class="step-n">${step.done ? '✓' : i + 1}</span>${esc(step.label)}
              </a>`).join('')}
          </div>
          ${currentIndex === -1 ? '' : `<a class="btn btn-primary btn-sm" href="${steps[currentIndex].href || '#'}">
             Continue setup ${icon('zap', 14)}</a>`}
        </div>
      </div>
    </div>`;
}

function quickActions(base) {
  const actions = [
    { label: 'Add Team', icon: 'teams', href: `${base}/teams`, need: 'teams:write' },
    { label: 'Generate Fixtures', icon: 'zap', href: `${base}/fixtures`, need: 'fixtures:write' },
    { label: 'Enter Results', icon: 'edit', href: `${base}/matches`, need: 'results:write' },
    { label: 'Rankings', icon: 'trophy', href: `${base}/leaderboard` },
    { label: 'Qualification', icon: 'target', href: `${base}/qualification`, need: 'qualification:write' },
    { label: 'Settings', icon: 'settings', href: `${base}/settings`, need: 'tournament:write' },
  ].filter((a) => !a.need || can(a.need));

  return `
    <div class="card">
      <div class="card-head"><h2>Quick actions</h2></div>
      <div class="card-body">
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px">
          ${actions.map((a) => `
            <a class="btn" href="${a.href}" style="justify-content:flex-start;padding:11px 13px">
              ${icon(a.icon, 15)} ${esc(a.label)}
            </a>`).join('')}
        </div>
      </div>
    </div>`;
}

function standingsCard(standings, base) {
  const withResults = standings.filter((s) => s.matches_played > 0);
  return `
    <div class="card">
      <div class="card-head">
        <h2>Leaderboard</h2>
        <a class="btn btn-ghost btn-sm" href="${base}/leaderboard">Full table</a>
      </div>
      <div class="card-body tight">
        ${withResults.length ? `
          <div class="table-wrap">
            <table class="data compact">
              <thead><tr>
                <th style="width:44px">#</th><th>Team</th>
                <th class="num">Pld</th><th class="num">WWCD</th>
                <th class="num">Kills</th><th class="num">Pts</th><th style="width:44px"></th>
              </tr></thead>
              <tbody>
                ${withResults.slice(0, 10).map((s) => `
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
        : emptyState({ icon: 'trophy', title: 'No results yet', message: 'Enter a match result and the leaderboard builds itself.' })}
      </div>
    </div>`;
}

function upcomingCard(upcoming, base) {
  return `
    <div class="card">
      <div class="card-head">
        <h2>Next up</h2>
        <a class="btn btn-ghost btn-sm" href="${base}/matches">Match center</a>
      </div>
      <div class="card-body ${upcoming.length ? '' : 'tight'}">
        ${upcoming.length ? `<div class="col" style="gap:9px">
          ${upcoming.map((m) => `
            <a class="match-card ${m.status === 'live' ? 'live' : ''}" href="${base}/matches/${m.id}">
              <div class="row-between">
                <span style="font-weight:620">${esc(m.label || `Match ${m.match_no}`)}</span>
                ${statusBadge(m.status)}
              </div>
              <div class="row small muted wrap" style="gap:12px">
                <span>${icon('calendar', 13)} ${formatDateTime(m.scheduled_at)}</span>
                ${m.map ? `<span>${esc(m.map)}</span>` : ''}
                ${m.group_name ? `<span>${esc(m.group_name)}</span>` : ''}
              </div>
            </a>`).join('')}
        </div>` : emptyState({ icon: 'calendar', title: 'Nothing scheduled', message: 'Generate fixtures to fill the calendar.' })}
      </div>
    </div>`;
}

function progressCard(progress) {
  if (!progress?.length) return '';
  return `
    <div class="card">
      <div class="card-head"><h2>Kills per match</h2></div>
      <div class="card-body">
        ${barChart(progress.map((p) => ({ label: `M${p.match_no}`, value: p.kills })), { height: 130 })}
      </div>
    </div>`;
}

function recentCard(recent, base) {
  if (!recent?.length) return '';
  return `
    <div class="card">
      <div class="card-head"><h2>Recent results</h2></div>
      <div class="card-body tight">
        ${recent.map((m) => `
          <div style="padding:11px 15px;border-bottom:1px solid var(--border-soft)">
            <div class="row-between mb-1">
              <a class="small" style="font-weight:600" href="${base}/matches/${m.id}">${esc(m.label || `Match ${m.match_no}`)}</a>
              <span class="tiny dim">${esc(m.map || '')}</span>
            </div>
            ${m.top.map((r, i) => `
              <div class="row small" style="gap:8px;padding:2px 0">
                ${rankPill(r.placement || i + 1)}
                <span class="grow truncate">${esc(r.name)}</span>
                <span class="dim tiny">${r.kills} kills</span>
                <span class="mono" style="font-weight:600">${points(r.total_points)}</span>
              </div>`).join('')}
          </div>`).join('')}
      </div>
    </div>`;
}

function activityCard(notifications, base) {
  return `
    <div class="card">
      <div class="card-head">
        <h2>Activity</h2>
        <a class="btn btn-ghost btn-sm" href="${base}/activity">All</a>
      </div>
      <div class="card-body ${notifications.length ? '' : 'tight'}">
        ${notifications.length ? `<div class="col" style="gap:11px">
          ${notifications.slice(0, 6).map((n) => `
            <div class="row" style="gap:9px;align-items:flex-start">
              <span style="color:var(--${severityColour(n.severity)});margin-top:2px">${icon(severityIcon(n.severity), 14)}</span>
              <div class="grow">
                <div class="small" style="font-weight:560">${esc(n.title)}</div>
                ${n.body ? `<div class="tiny muted truncate">${esc(n.body)}</div>` : ''}
                <div class="tiny dim">${relativeTime(n.created_at, { assumeUtc: true })}</div>
              </div>
              ${n.read_at ? '' : '<span class="dot" style="background:var(--primary);margin-top:6px"></span>'}
            </div>`).join('')}
        </div>` : emptyState({ icon: 'bell', title: 'Nothing yet', message: 'Notifications appear as matches progress.' })}
      </div>
    </div>`;
}

const severityColour = (s) => ({ success: 'success', warning: 'warning', danger: 'danger' }[s] || 'accent');
const severityIcon = (s) => ({ success: 'check', warning: 'alert', danger: 'alert' }[s] || 'info');

/** Small download menu -- every export the spec asks for, in one place. */
function exportMenu(tournamentId) {
  import('../lib/ui.js').then(({ modal }) => {
    const options = [
      ['Leaderboard', 'leaderboard', ['pdf', 'xlsx', 'csv']],
      ['Match schedule', 'schedule', ['pdf', 'xlsx', 'csv']],
      ['Teams & players', 'teams', ['xlsx', 'csv', 'pdf']],
      ['All match results', 'results', ['xlsx', 'csv', 'pdf']],
      ['Complete tournament', 'tournament', ['xlsx', 'json']],
    ];
    modal({
      title: 'Export tournament data',
      size: 'narrow',
      body: `<div class="col" style="gap:12px">
        ${options.map(([label, kind, formats]) => `
          <div class="row-between" style="gap:10px">
            <span class="small" style="font-weight:560">${esc(label)}</span>
            <span class="row gap-sm">
              ${formats.map((f) => `<button class="btn btn-sm" data-dl="/api/tournaments/${tournamentId}/export/${kind}.${f}">
                ${f.toUpperCase()}</button>`).join('')}
            </span>
          </div>`).join('')}
      </div>`,
      onMount(overlay, close) {
        overlay.querySelectorAll('[data-dl]').forEach((btn) => {
          btn.addEventListener('click', () => {
            download(btn.dataset.dl);
            toast('Download started.', { type: 'success' });
            close();
          });
        });
      },
    });
  });
}

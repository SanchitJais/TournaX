/** Notifications feed and the audit history of who changed what. */
import { api } from '../lib/api.js';
import { delegate, esc, html, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { emptyState, modal, relativeTime, toast, toastError } from '../lib/ui.js';
import { can, refreshUnread } from '../main.js';

const ACTION_META = {
  'tournament.created': ['trophy', 'success'], 'tournament.updated': ['settings', 'info'],
  'tournament.deleted': ['trash', 'danger'], 'settings.updated': ['settings', 'info'],
  'team.created': ['teams', 'success'], 'team.updated': ['edit', 'info'], 'team.deleted': ['trash', 'danger'],
  'teams.imported': ['upload', 'success'], 'teams.grouped': ['layers', 'info'],
  'fixtures.generated': ['zap', 'success'], 'match.created': ['calendar', 'info'],
  'match.updated': ['edit', 'info'], 'match.deleted': ['trash', 'danger'],
  'match.credentials': ['key', 'info'], 'result.created': ['check', 'success'],
  'result.updated': ['edit', 'warning'], 'result.cleared': ['trash', 'danger'],
  'qualification.locked': ['target', 'success'], 'stage.created': ['layers', 'success'],
  'stage.deleted': ['trash', 'danger'], 'member.added': ['users', 'info'],
  'user.created': ['users', 'info'], 'user.updated': ['edit', 'info'], 'user.deleted': ['trash', 'danger'],
};

export default {
  title: 'Activity',

  async load(ctx) {
    const id = Number(ctx.params.id);
    const [notifications, audit] = await Promise.all([
      api.get(`/api/tournaments/${id}/notifications?limit=60`),
      can('audit:read')
        ? api.get(`/api/tournaments/${id}/audit?limit=120`).catch(() => ({ entries: [] }))
        : Promise.resolve({ entries: [] }),
    ]);
    return { tournamentId: id, ...notifications, audit: audit.entries, tab: ctx.query.tab || 'notifications' };
  },

  render(data) {
    const { notifications, audit, unread, tab, tournamentId } = data;

    return html`
      <div class="page" style="max-width:1050px">
        <div class="page-head">
          <div class="page-title">
            <h1>Activity</h1>
            <p class="muted small" style="margin:0">Notifications for everyone, and a full record of every change made.</p>
          </div>
          ${unread ? raw(`<button class="btn" data-act="read-all">${icon('check', 15)} Mark all read (${unread})</button>`) : ''}
        </div>

        <div class="tabs mb-3">
          <a class="tab ${tab === 'notifications' ? 'active' : ''}" href="/admin/t/${tournamentId}/activity?tab=notifications">
            Notifications ${unread ? raw(`<span class="nav-badge" style="margin-left:6px">${unread}</span>`) : ''}
          </a>
          ${can('audit:read') ? raw(`
            <a class="tab ${tab === 'audit' ? 'active' : ''}" href="/admin/t/${tournamentId}/activity?tab=audit">
              Change history</a>`) : ''}
        </div>

        ${tab === 'audit' ? raw(auditList(audit)) : raw(notificationList(notifications))}
      </div>`;
  },

  mounted(data, ctx, root) {
    delegate(root, {
      async 'read-all'() {
        try {
          await api.post(`/api/tournaments/${data.tournamentId}/notifications/read-all`);
          refreshUnread();
          toast('All caught up.', { type: 'success' });
          ctx.navigate(`/admin/t/${data.tournamentId}/activity?tab=${data.tab}`, { replace: true });
        } catch (err) { toastError(err); }
      },

      detail(el) {
        const entry = data.audit.find((a) => a.id === Number(el.dataset.id));
        if (!entry) return;
        modal({
          title: entry.summary,
          body: `
            <dl class="kv">
              <dt>Action</dt><dd class="mono">${esc(entry.action)}</dd>
              <dt>Who</dt><dd>${esc(entry.actor_name || 'System')}</dd>
              <dt>When</dt><dd>${esc(entry.created_at)} UTC (${relativeTime(entry.created_at, { assumeUtc: true })})</dd>
              ${entry.entity ? `<dt>Entity</dt><dd>${esc(entry.entity)} #${entry.entity_id ?? '--'}</dd>` : ''}
            </dl>
            ${entry.before ? `<div class="divider"></div><div class="label mb-1">Before</div>
              <pre class="lobby mono tiny" style="overflow:auto;max-height:190px">${esc(JSON.stringify(entry.before, null, 2))}</pre>` : ''}
            ${entry.after ? `<div class="label mb-1 mt-2">After</div>
              <pre class="lobby mono tiny" style="overflow:auto;max-height:190px">${esc(JSON.stringify(entry.after, null, 2))}</pre>` : ''}`,
          footer: '<button class="btn btn-primary" data-modal-close>Close</button>',
        });
      },
    });
  },
};

function notificationList(notifications) {
  if (!notifications.length) {
    return emptyState({
      icon: 'bell', title: 'No notifications yet',
      message: 'Match reminders, room releases, results and qualification updates all land here.',
    });
  }
  return `
    <div class="card">
      <div class="card-body tight">
        ${notifications.map((n) => {
          const tone = { success: 'success', warning: 'warning', danger: 'danger' }[n.severity] || 'accent';
          const glyph = { success: 'check', warning: 'alert', danger: 'alert' }[n.severity] || 'info';
          return `
            <div class="row" style="gap:12px;padding:13px 16px;border-bottom:1px solid var(--border-soft);align-items:flex-start
                 ${n.read_at ? '' : ';background:rgba(124,92,255,0.045)'}">
              <span style="color:var(--${tone});margin-top:2px">${icon(glyph, 16)}</span>
              <div class="grow">
                <div class="row" style="gap:8px">
                  <span style="font-weight:600">${esc(n.title)}</span>
                  ${n.read_at ? '' : '<span class="badge badge-info">New</span>'}
                </div>
                ${n.body ? `<div class="small muted mt-0">${esc(n.body)}</div>` : ''}
                <div class="tiny dim mt-1">
                  ${esc(n.type)} · ${relativeTime(n.created_at, { assumeUtc: true })}
                </div>
              </div>
              ${n.link ? `<a class="btn btn-sm" href="${esc(n.link)}">Open</a>` : ''}
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

function auditList(entries) {
  if (!entries.length) {
    return emptyState({ icon: 'history', title: 'No changes recorded yet', message: 'Every edit is logged here with who made it and when.' });
  }
  return `
    <div class="card">
      <div class="card-body tight">
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th style="width:38px"></th><th>What changed</th><th>Who</th><th>When</th><th style="width:70px"></th></tr></thead>
            <tbody>
              ${entries.map((e) => {
                const [glyph, tone] = ACTION_META[e.action] || ['info', 'info'];
                return `
                  <tr>
                    <td><span style="color:var(--${tone === 'info' ? 'accent' : tone})">${icon(glyph, 15)}</span></td>
                    <td>
                      <div style="font-weight:560">${esc(e.summary)}</div>
                      <div class="tiny dim mono">${esc(e.action)}</div>
                    </td>
                    <td class="small">${esc(e.actor_name || 'System')}</td>
                    <td class="small dim nowrap">${relativeTime(e.created_at, { assumeUtc: true })}</td>
                    <td>
                      ${e.before || e.after
                        ? `<button class="btn btn-ghost btn-sm" data-act="detail" data-id="${e.id}">Details</button>`
                        : ''}
                    </td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

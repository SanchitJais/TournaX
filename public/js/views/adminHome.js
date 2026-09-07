/** Tournament picker -- the organizer's landing page. */
import { api } from '../lib/api.js';
import { delegate, esc, html, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { confirmAction, emptyState, formatDate, num, toast, toastError } from '../lib/ui.js';
import { invalidateTournament } from '../main.js';

export default {
  title: 'Tournaments',

  async load(ctx) {
    if (!ctx.state.user) { ctx.navigate('/login', { replace: true }); return null; }
    return api.get('/api/tournaments');
  },

  render(data, ctx) {
    if (!data) return '';
    const { tournaments } = data;
    // Scorekeepers, team managers and spectators are given access to tournaments
    // rather than creating their own, so don't offer them a dead-end button.
    const canCreate = ['super_admin', 'tournament_admin'].includes(ctx.state.user?.role);

    return html`
      <div class="page">
        <div class="page-head">
          <div class="page-title">
            <h1>${canCreate ? 'Your tournaments' : 'Tournaments you can access'}</h1>
            <p class="muted small" style="margin:0">
              ${canCreate
                ? 'Create a tournament, add teams, and let the system handle the rest.'
                : 'Tournaments an organizer has given you access to.'}
            </p>
          </div>
          ${canCreate ? raw(`<a class="btn btn-primary" href="/admin/new">${icon('plus', 15)} New tournament</a>`) : ''}
        </div>

        ${tournaments.length ? raw(`
          <div class="grid grid-auto">${tournaments.map(card).join('')}</div>
        `) : raw(canCreate
          ? emptyState({
            icon: 'trophy',
            title: 'No tournaments yet',
            message: 'Set one up in under a minute -- pick a template, add your teams, and generate fixtures automatically.',
            action: '<a class="btn btn-primary mt-2" href="/admin/new">Create your first tournament</a>',
          })
          : emptyState({
            icon: 'lock',
            title: 'No tournaments shared with you yet',
            message: 'An organizer needs to grant your account access before a tournament appears here. '
              + 'In the meantime you can follow along on the public site.',
            action: '<a class="btn btn-primary mt-2" href="/">Browse public tournaments</a>',
          }))}
      </div>`;
  },

  mounted(_data, ctx, root) {
    delegate(root, {
      async delete(el) {
        const { id, name } = el.dataset;
        const ok = await confirmAction({
          title: 'Delete tournament',
          message: `Delete "${name}"?`,
          detail: 'Every team, fixture, result and ranking for this tournament is removed. This cannot be undone.',
          confirmLabel: 'Delete permanently',
        });
        if (!ok) return;
        try {
          await api.delete(`/api/tournaments/${id}`);
          invalidateTournament();
          toast('Tournament deleted.', { type: 'success' });
          ctx.navigate('/admin');
        } catch (err) { toastError(err); }
      },
    });
  },
};

function card(t) {
  const progress = t.counts.matches ? Math.round((t.counts.completed / t.counts.matches) * 100) : 0;
  const statusClass = { live: 'badge-live', completed: 'badge-completed', draft: 'badge-draft', archived: 'badge-cancelled' }[t.status] || 'badge-neutral';

  return `
    <div class="tournament-card">
      <a href="/admin/t/${t.id}" style="display:block">
        <div class="thumb">
          ${t.banner_url ? `<img src="${esc(t.banner_url)}" alt="">` : ''}
        </div>
        <div style="padding:14px 15px">
          <div class="row-between" style="align-items:flex-start">
            <div class="grow" style="min-width:0">
              <div class="truncate" style="font-weight:650;font-size:15px">${esc(t.name)}</div>
              <div class="tiny dim mt-0">${esc(t.game)} · ${esc(t.match_format)}</div>
            </div>
            <span class="badge ${statusClass}">${t.status === 'live' ? '<span class="dot"></span>' : ''}${esc(t.status)}</span>
          </div>

          <div class="row mt-2 small muted" style="gap:14px">
            <span>${icon('teams', 13)} ${num(t.counts.teams)} teams</span>
            <span>${icon('calendar', 13)} ${num(t.counts.matches)} matches</span>
          </div>

          <div class="mt-2">
            <div class="row-between tiny dim mb-1">
              <span>${t.counts.completed} of ${t.counts.matches} played</span>
              <span>${progress}%</span>
            </div>
            <div class="progress"><span style="width:${progress}%"></span></div>
          </div>

          ${t.start_date ? `<div class="tiny dim mt-2">Starts ${formatDate(t.start_date, { withYear: true })}</div>` : ''}
        </div>
      </a>
      <div class="row-between" style="padding:10px 15px;border-top:1px solid var(--border-soft)">
        <a class="btn btn-ghost btn-sm" href="/t/${esc(t.slug)}" data-native="true" target="_blank">
          ${icon('external', 13)} Public page
        </a>
        <button class="btn btn-ghost btn-icon" data-act="delete" data-id="${t.id}"
                data-name="${esc(t.name)}" title="Delete tournament">${icon('trash', 14)}</button>
      </div>
    </div>`;
}

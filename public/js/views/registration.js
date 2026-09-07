/** Public tournament registration page. */
import { api } from '../lib/api.js';
import { $, delegate, esc, html, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import {
  confirmAction, emptyState, formatDate, formatDateTime, teamLogo, toast, toastError, withBusy,
} from '../lib/ui.js';
import { bindShare, shareBox } from '../lib/share.js';
import { platformFooter, platformNav } from './chrome.js';

export default {
  title: (data) => `Register — ${data?.tournament?.name || 'Tournament'}`,

  load: (ctx) => api.get(`/api/public/t/${ctx.params.slug}/registration`),

  render(data, ctx) {
    const { tournament, state, my_registration: mine, my_squads: squads, approved_teams: approved, check_in: checkIn } = data;
    const signedIn = Boolean(ctx.state.user);
    const slots = state.slots || 0;
    const pct = slots ? Math.min(100, Math.round((state.counts.total / slots) * 100)) : 0;

    return html`
      <div class="pub">
        ${raw(platformNav(ctx, 'tournaments'))}
        <main class="pub-main" style="max-width:1100px">
          <div class="banner mb-3">
            ${tournament.banner_url ? raw(`<img src="${esc(tournament.banner_url)}" alt="">`) : ''}
            <div class="banner-inner">
              ${tournament.logo_url
                ? raw(`<img src="${esc(tournament.logo_url)}" alt="" style="width:58px;height:58px;border-radius:14px;object-fit:cover">`)
                : ''}
              <div class="grow" style="min-width:220px">
                <div class="row gap-sm mb-1">
                  <span class="badge badge-info">${tournament.game}</span>
                  ${tournament.prize_pool ? raw(`<span class="badge badge-warning">${icon('trophy', 11)} ${esc(tournament.prize_pool)}</span>`) : ''}
                  ${state.open ? '<span class="badge badge-qualified">Registration open</span>' : '<span class="badge badge-neutral">Registration closed</span>'}
                </div>
                <h1 class="hero-title">${tournament.name}</h1>
                <div class="row wrap small muted mt-1" style="gap:14px">
                  ${tournament.start_date ? raw(`<span>${icon('calendar', 13)} ${formatDate(tournament.start_date, { withYear: true })}</span>`) : ''}
                  ${tournament.organizer_name ? raw(`<span>by ${esc(tournament.organizer_name)}</span>`) : ''}
                  ${tournament.region ? raw(`<span>${esc(tournament.region)}</span>`) : ''}
                </div>
              </div>
              <a class="btn" href="/tournament/${esc(tournament.slug)}">View tournament</a>
            </div>
          </div>

          <div class="grid grid-2" style="grid-template-columns:minmax(0,1fr) minmax(0,1.15fr)">
            <div class="col" style="gap:16px">
              <div class="reg-panel">
                <div class="stat-label">Teams registered</div>
                <div class="reg-count">${state.counts.total}${slots ? ` / ${slots}` : ''}</div>
                ${slots ? raw(`<div class="slots-bar"><span style="width:${pct}%"></span></div>`) : ''}
                <div class="small muted">
                  ${state.counts.pending ? `${state.counts.pending} awaiting approval · ` : ''}
                  ${state.counts.approved} confirmed
                </div>

                ${state.deadline ? raw(`
                  <div class="divider"></div>
                  <div class="stat-label">Registration closes</div>
                  <div style="font-weight:650;font-size:15px">${formatDateTime(state.deadline)}</div>`) : ''}

                <div class="divider"></div>
                ${raw(actionBlock({ signedIn, state, mine, squads, tournament }))}
              </div>

              ${checkIn?.enabled && mine?.status === 'approved' ? raw(`
                <div class="card">
                  <div class="card-head"><h2>Check-in</h2>
                    ${mine.checked_in_at ? '<span class="badge badge-completed">Checked in</span>' : ''}
                  </div>
                  <div class="card-body">
                    ${mine.checked_in_at
                      ? `<p class="small muted" style="margin:0">Your team is checked in. See you in the lobby.</p>`
                      : checkIn.open
                        ? `<p class="small muted">Confirm your team is ready to play. Check-in closes at
                             <b>${formatDateTime(checkIn.closes_at)}</b>.</p>
                           <button class="btn btn-primary btn-block" data-act="check-in" data-busy-label="Checking in">
                             ${icon('check', 15)} Check in now</button>`
                        : `<p class="small muted" style="margin:0">${esc(checkIn.reason || 'Check-in is not open yet.')}</p>`}
                  </div>
                </div>`) : ''}

              <div class="card">
                <div class="card-body">${raw(shareBox(`/tournament/${tournament.slug}/register`, { label: 'Share this registration page' }))}</div>
              </div>
            </div>

            <div class="col" style="gap:16px">
              ${tournament.entry_requirements ? raw(`
                <div class="card">
                  <div class="card-head"><h2>Entry requirements</h2></div>
                  <div class="card-body"><p class="small muted" style="margin:0;white-space:pre-wrap">${esc(tournament.entry_requirements)}</p></div>
                </div>`) : ''}

              <div class="card">
                <div class="card-head"><h2>Format</h2></div>
                <div class="card-body">
                  <dl class="kv">
                    <dt>Game</dt><dd>${tournament.game}</dd>
                    <dt>Match format</dt><dd>${tournament.match_format}</dd>
                    <dt>Squad size</dt><dd>${tournament.min_players}–${tournament.max_players} players</dd>
                    ${slots ? raw(`<dt>Slots</dt><dd>${slots} teams</dd>`) : ''}
                    <dt>Approval</dt>
                    <dd>${state.approval_mode === 'manual' ? 'Reviewed by the organizer' : 'Automatic'}</dd>
                  </dl>
                  <a class="btn btn-block mt-2" href="/tournament/${esc(tournament.slug)}/rules">${raw(icon('file', 15))} Read the rules</a>
                </div>
              </div>

              <div class="card">
                <div class="card-head"><h2>Registered teams</h2><span class="badge badge-neutral">${approved.length}</span></div>
                <div class="card-body ${approved.length ? 'tight' : ''}">
                  ${approved.length ? raw(`
                    <div style="max-height:340px;overflow-y:auto">
                      ${approved.map((t) => `
                        <div class="row" style="gap:10px;padding:9px 15px;border-bottom:1px solid var(--border-soft)">
                          ${teamLogo({ name: t.team_name, logo_url: t.logo_url }, 'sm')}
                          <span class="grow truncate" style="font-weight:560">${esc(t.team_name)}</span>
                          ${t.checked_in_at ? '<span class="badge badge-completed">Ready</span>' : ''}
                        </div>`).join('')}
                    </div>`)
                  : raw(emptyState({ icon: 'teams', title: 'No teams yet', message: 'Be the first to register.' }))}
                </div>
              </div>
            </div>
          </div>
        </main>
        ${raw(platformFooter(tournament.name))}
      </div>`;
  },

  mounted(data, ctx, root) {
    bindShare(root);
    const tournamentId = data.tournament.id;
    const reload = () => ctx.navigate(`/tournament/${data.tournament.slug}/register`, { replace: true });

    delegate(root, {
      async register(el) {
        const squadId = $('#squad-select', root)?.value;
        if (!squadId) { toast('Choose which team you are registering.', { type: 'error' }); return; }
        await withBusy(el, async () => {
          const res = await api.post(`/api/tournaments/${tournamentId}/register`, { squad_id: Number(squadId) });
          toast(
            res.registration.status === 'approved'
              ? 'You are in. See you at the tournament.'
              : 'Registration submitted. The organizer will review it shortly.',
            { type: 'success', title: 'Registered' },
          );
          reload();
        });
      },

      async withdraw(el) {
        const ok = await confirmAction({
          title: 'Withdraw registration',
          message: `Withdraw ${data.mine.team_name} from ${data.tournament.name}?`,
          detail: 'Your slot is released and any fixtures involving your team are removed.',
          confirmLabel: 'Withdraw',
        });
        if (!ok) return;
        try {
          await api.post(`/api/tournaments/${tournamentId}/registrations/${data.mine.id}/withdraw`);
          toast('Registration withdrawn.');
          reload();
        } catch (err) { toastError(err); }
      },

      async 'check-in'(el) {
        await withBusy(el, async () => {
          await api.post(`/api/tournaments/${tournamentId}/check-in`, {});
          toast('Checked in. Good luck!', { type: 'success' });
          reload();
        });
      },
    });
  },
};

/** The one call to action, whatever the viewer's situation is. */
function actionBlock({ signedIn, state, mine, squads, tournament }) {
  if (!signedIn) {
    return `
      <p class="small muted">Sign in with your player account to register a team.</p>
      <a class="btn btn-primary btn-block btn-lg" href="/login">${icon('users', 16)} Sign in to register</a>`;
  }

  if (mine && mine.status !== 'rejected') {
    const label = {
      approved: '<span class="badge badge-qualified">Confirmed</span>',
      pending: '<span class="badge badge-warning">Awaiting approval</span>',
    }[mine.status] || '';
    return `
      <div class="row-between mb-2">
        <div>
          <div class="small dim">Your registration</div>
          <div style="font-weight:650">${esc(mine.team_name)}</div>
        </div>
        ${label}
      </div>
      ${mine.status === 'pending'
        ? '<p class="small muted">The organizer reviews entries manually. You will be notified when it is decided.</p>'
        : '<p class="small muted">Your team is in. Watch for check-in and fixtures.</p>'}
      <button class="btn btn-danger btn-block mt-1" data-act="withdraw">Withdraw registration</button>`;
  }

  if (!state.open) {
    return `
      <div class="warn-box">${icon('lock', 15)}<div>${esc(state.reason || 'Registration is closed.')}</div></div>
      ${mine?.status === 'rejected'
        ? `<p class="small muted mt-2">Your previous entry was not accepted${mine.reject_reason ? `: ${esc(mine.reject_reason)}` : '.'}</p>`
        : ''}`;
  }

  if (!squads.length) {
    return `
      <p class="small muted">You need to be the captain of a team to register it.</p>
      <a class="btn btn-primary btn-block" href="/me/teams">${icon('teams', 15)} Create a team</a>`;
  }

  return `
    ${mine?.status === 'rejected' ? `
      <div class="warn-box mb-2">${icon('alert', 15)}
        <div>A previous entry was not accepted${mine.reject_reason ? `: ${esc(mine.reject_reason)}` : ''}. You can apply again.</div>
      </div>` : ''}
    <div class="field mb-2">
      <label class="label" for="squad-select">Register which team?</label>
      <select class="select" id="squad-select">
        ${squads.map((s) => `<option value="${s.id}">${esc(s.name)} (${s.member_count} players)</option>`).join('')}
      </select>
      <span class="hint">Needs ${tournament.min_players}–${tournament.max_players} players with completed profiles.</span>
    </div>
    <button class="btn btn-primary btn-block btn-lg" data-act="register" data-busy-label="Registering">
      ${icon('zap', 16)} Register now
    </button>`;
}

/** The signed-in player's area: dashboard, profile, teams and invitations. */
import { api } from '../lib/api.js';
import { $, delegate, esc, formData, html, raw, readImage } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import {
  confirmAction, emptyState, formatDate, formatDateTime, formatTime, modal, points,
  statusBadge, teamLogo, toast, toastError, withBusy,
} from '../lib/ui.js';
import { bindShare, shareBox } from '../lib/share.js';
import { platformFooter, platformNav } from './chrome.js';

const SECTIONS = [
  ['dashboard', 'Overview', ''],
  ['matches', 'My Matches', '/matches'],
  ['teams', 'My Teams', '/teams'],
  ['invites', 'Invitations', '/invites'],
  ['profile', 'Profile', '/profile'],
];

export default {
  title: 'My Dashboard',

  async load(ctx) {
    if (!ctx.state.user) { ctx.navigate('/login', { replace: true }); return null; }
    const section = ctx.params.section || 'dashboard';
    const [me, dashboard] = await Promise.all([api.get('/api/me'), api.get('/api/me/dashboard')]);
    return { section, me, dashboard, games: me.games };
  },

  render(data, ctx) {
    if (!data) return '';
    const { section, me, dashboard } = data;

    return html`
      <div class="pub">
        ${raw(platformNav(ctx, null))}
        <main class="pub-main">
          <div class="page-head">
            <div class="page-title">
              <h1>Hi, ${me.profile?.ign || me.user.name}</h1>
              <p class="muted small" style="margin:0">
                ${dashboard.squads.length} team(s) · ${dashboard.tournaments.all.length} tournament(s)
              </p>
            </div>
            ${dashboard.invites.length ? raw(`
              <a class="btn btn-primary" href="/me/invites">
                ${icon('bell', 15)} ${dashboard.invites.length} invitation(s)
              </a>`) : ''}
          </div>

          ${!me.profile_complete ? raw(`
            <div class="warn-box mb-3">
              ${icon('alert', 16)}
              <div class="grow">
                <b>Your profile is incomplete.</b> Full name, in-game name and phone number are required
                before your team can be registered for a tournament.
              </div>
              <a class="btn btn-sm" href="/me/profile">Complete it</a>
            </div>`) : ''}

          <div class="tabs mb-3">
            ${raw(SECTIONS.map(([key, label, path]) => `
              <a class="tab ${section === key ? 'active' : ''}" href="/me${path}">
                ${esc(label)}${key === 'invites' && dashboard.invites.length ? `<span class="nav-badge" style="margin-left:6px">${dashboard.invites.length}</span>` : ''}
              </a>`).join(''))}
          </div>

          ${raw({
            dashboard: () => overview(data),
            matches: () => matchesSection(data),
            teams: () => teamsSection(data),
            invites: () => invitesSection(data),
            profile: () => profileSection(data),
          }[section]?.() || overview(data))}
        </main>
        ${raw(platformFooter())}
      </div>`;
  },

  mounted(data, ctx, root) {
    if (!data) return;
    bindShare(root);

    let avatarData = null;
    $('#avatar-input', root)?.addEventListener('change', async (e) => {
      try {
        avatarData = await readImage(e.target);
        const preview = $('#avatar-preview', root);
        if (preview && avatarData) preview.innerHTML = `<img src="${avatarData}" alt="" style="width:100%;height:100%;object-fit:cover">`;
      } catch (err) { toastError(err); }
    });

    delegate(root, {
      async 'save-profile'(el) {
        const form = $('#profile-form', root);
        const values = formData(form);

        // Mirror the server rule so the three starred fields fail fast.
        const problems = [];
        if (!values.full_name?.trim()) problems.push('full_name');
        if (!values.ign?.trim()) problems.push('ign');
        if (!/^[+()\d][\d\s()-]{5,19}$/.test(values.phone || '')) problems.push('phone');

        root.querySelectorAll('.field').forEach((f) => f.classList.remove('invalid'));
        if (problems.length) {
          problems.forEach((name) => form.querySelector(`[name=${name}]`)?.closest('.field')?.classList.add('invalid'));
          toast('Fill in the required fields marked with a star.', { type: 'error' });
          form.querySelector(`[name=${problems[0]}]`)?.focus();
          return;
        }

        await withBusy(el, async () => {
          await api.put('/api/me/profile', { ...values, avatar_url: avatarData || undefined });
          toast('Profile saved.', { type: 'success' });
          ctx.navigate('/me/profile', { replace: true });
        });
      },

      'create-team': () => createTeamDialog(ctx),

      async 'accept-invite'(el) {
        try {
          await api.post(`/api/me/invites/${el.dataset.id}`, { accept: true });
          toast('You joined the team.', { type: 'success' });
          ctx.navigate('/me/invites', { replace: true });
        } catch (err) { toastError(err); }
      },

      async 'decline-invite'(el) {
        try {
          await api.post(`/api/me/invites/${el.dataset.id}`, { accept: false });
          toast('Invitation declined.');
          ctx.navigate('/me/invites', { replace: true });
        } catch (err) { toastError(err); }
      },

      async 'leave-team'(el) {
        const ok = await confirmAction({
          title: 'Leave team',
          message: `Leave ${el.dataset.name}?`,
          detail: 'You will lose access to the team\'s upcoming matches.',
          confirmLabel: 'Leave team',
        });
        if (!ok) return;
        try {
          await api.post(`/api/squads/${el.dataset.id}/leave`);
          toast('You left the team.');
          ctx.navigate('/me/teams', { replace: true });
        } catch (err) { toastError(err); }
      },

      async 'check-in'(el) {
        try {
          await api.post(`/api/tournaments/${el.dataset.tournament}/check-in`, {});
          toast('Checked in. Good luck!', { type: 'success', title: 'You are in' });
          ctx.navigate(`/me${SECTIONS.find(([k]) => k === data.section)?.[2] || ''}`, { replace: true });
        } catch (err) { toastError(err); }
      },
    });
  },
};

// --------------------------------------------------------------- sections --
function overview({ dashboard }) {
  const { tournaments, career, squads, matches } = dashboard;
  const next = matches.filter((m) => m.status !== 'completed').slice(0, 4);

  return `
    <div class="grid grid-stats mb-3">
      ${[
        ['Tournaments', tournaments.all.length, `${tournaments.live.length} live`],
        ['Matches played', career.matches, `${career.wins} win(s)`],
        ['Points earned', points(career.team_points), `${career.avg_points} avg`],
        career.has_individual_stats
          ? ['Your kills', career.kills, `${career.avg_kills} per match`]
          : ['Best placement', career.best_placement ? `#${career.best_placement}` : '--', 'across all matches'],
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
          <div class="card-head"><h2>My tournaments</h2><a class="btn btn-ghost btn-sm" href="/tournaments">Find more</a></div>
          <div class="card-body ${tournaments.all.length ? '' : 'tight'}">
            ${tournaments.all.length
              ? `<div class="col" style="gap:10px">${tournaments.all.map(tournamentRow).join('')}</div>`
              : emptyState({
                icon: 'trophy', title: 'You have not entered a tournament yet',
                message: 'Browse open tournaments and register with your team.',
                action: '<a class="btn btn-primary mt-2" href="/tournaments">Browse tournaments</a>',
              })}
          </div>
        </div>
      </div>

      <div class="col" style="gap:16px">
        <div class="card">
          <div class="card-head"><h2>Next matches</h2><a class="btn btn-ghost btn-sm" href="/me/matches">All</a></div>
          <div class="card-body ${next.length ? '' : 'tight'}">
            ${next.length
              ? `<div class="col" style="gap:9px">${next.map(matchCard).join('')}</div>`
              : emptyState({ icon: 'calendar', title: 'No matches scheduled' })}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>My teams</h2><a class="btn btn-ghost btn-sm" href="/me/teams">Manage</a></div>
          <div class="card-body ${squads.length ? '' : 'tight'}">
            ${squads.length ? `<div class="col" style="gap:9px">${squads.map(squadRow).join('')}</div>`
              : emptyState({ icon: 'teams', title: 'No team yet', message: 'Create one or accept an invitation.' })}
          </div>
        </div>
      </div>
    </div>`;
}

function tournamentRow(t) {
  const badge = {
    approved: '<span class="badge badge-qualified">Registered</span>',
    pending: '<span class="badge badge-warning">Awaiting approval</span>',
    rejected: '<span class="badge badge-eliminated">Not accepted</span>',
  }[t.registration_status] || '';

  return `
    <div class="approval-row">
      ${teamLogo({ name: t.name, logo_url: t.logo_url }, 'sm')}
      <div class="grow" style="min-width:0">
        <a class="truncate" style="font-weight:620;display:block" href="/tournament/${esc(t.slug)}">${esc(t.name)}</a>
        <div class="tiny dim">
          ${esc(t.game)}${t.start_date ? ` · ${formatDate(t.start_date, { withYear: true })}` : ''}
          ${t.squad_name ? ` · as ${esc(t.squad_name)}` : ''}
        </div>
      </div>
      <div class="row gap-sm">
        ${t.checked_in_at ? '<span class="badge badge-completed">Checked in</span>' : badge}
        ${t.status === 'live' ? '<span class="live-pill"><span class="dot"></span>Live</span>' : ''}
      </div>
    </div>`;
}

const squadRow = (s) => `
  <div class="member-row">
    ${teamLogo(s, 'sm')}
    <div class="grow" style="min-width:0">
      <a class="truncate" style="font-weight:600;display:block" href="/team/${esc(s.slug)}">${esc(s.name)}</a>
      <div class="tiny dim">${s.member_count} player(s)</div>
    </div>
    <span class="role-pill ${esc(s.my_role)}">${esc(s.my_role)}</span>
  </div>`;

function matchCard(m) {
  const credentials = m.credentials || {};
  return `
    <div class="match-card ${m.status === 'live' ? 'live' : ''}">
      <div class="row-between">
        <a style="font-weight:620" href="/t/match/${m.id}">${esc(m.label || `Match ${m.match_no}`)}</a>
        ${statusBadge(m.status)}
      </div>
      <div class="row wrap small muted" style="gap:12px">
        <span>${icon('calendar', 13)} ${formatDateTime(m.scheduled_at)}</span>
        ${m.group_name ? `<span>${esc(m.group_name)}</span>` : ''}
        ${m.map ? `<span>${esc(m.map)}</span>` : ''}
      </div>
      <div class="tiny dim">${esc(m.tournament_name)} · ${esc(m.my_team_name)}</div>
      ${m.room_id
        ? `<div class="credentials tiny">${icon('key', 12)} Room ${esc(m.room_id)} / ${esc(m.room_password || '--')}</div>`
        : credentials.reveal_at
          ? `<div class="locked tiny">${icon('lock', 12)} Room details at ${formatTime(credentials.reveal_at)}</div>`
          : ''}
      ${m.result
        ? `<div class="row small" style="gap:10px">
             <span class="badge badge-completed">#${m.result.placement ?? '-'}</span>
             <span class="dim">${m.result.kills} kills</span>
             <span class="mono" style="font-weight:600">${points(m.result.total_points)} pts</span>
           </div>` : ''}
    </div>`;
}

function matchesSection({ dashboard }) {
  const { matches } = dashboard;
  if (!matches.length) {
    return emptyState({
      icon: 'calendar', title: 'No matches yet',
      message: 'Once your team is registered and fixtures are generated, every match you play appears here with its room details.',
    });
  }
  const upcoming = matches.filter((m) => m.status === 'upcoming' || m.status === 'live');
  const played = matches.filter((m) => m.status === 'completed');

  return `
    ${upcoming.length ? `
      <h2 class="mb-2">Upcoming</h2>
      <div class="grid grid-auto mb-3">${upcoming.map(matchCard).join('')}</div>` : ''}
    ${played.length ? `
      <h2 class="mb-2">Played</h2>
      <div class="grid grid-auto">${played.reverse().map(matchCard).join('')}</div>` : ''}`;
}

function teamsSection({ dashboard }) {
  const { squads } = dashboard;
  return `
    <div class="row-between mb-2">
      <h2>My teams</h2>
      <button class="btn btn-primary" data-act="create-team">${icon('plus', 15)} Create a team</button>
    </div>
    ${squads.length ? `
      <div class="grid grid-auto">
        ${squads.map((s) => `
          <div class="card">
            <div class="card-body">
              <div class="row" style="gap:11px">
                ${teamLogo(s, 'lg')}
                <div class="grow" style="min-width:0">
                  <a class="truncate" style="font-weight:650;font-size:15px;display:block" href="/team/${esc(s.slug)}">${esc(s.name)}</a>
                  <div class="tiny dim">${esc(s.game)} · ${s.member_count} player(s)</div>
                </div>
                <span class="role-pill ${esc(s.my_role)}">${esc(s.my_role)}</span>
              </div>
              <div class="row mt-2 gap-sm wrap">
                <a class="btn btn-sm" href="/team/${esc(s.slug)}">${icon('eye', 13)} Team page</a>
                ${s.my_role === 'captain'
                  ? `<a class="btn btn-sm btn-primary" href="/team/${esc(s.slug)}?manage=1">${icon('users', 13)} Manage roster</a>`
                  : `<button class="btn btn-sm btn-danger" data-act="leave-team" data-id="${s.id}" data-name="${esc(s.name)}">Leave</button>`}
              </div>
            </div>
          </div>`).join('')}
      </div>`
    : emptyState({
      icon: 'teams', title: 'You are not in a team yet',
      message: 'Create a team and invite your squad, or wait for a captain to invite you.',
      action: '<button class="btn btn-primary mt-2" data-act="create-team">Create a team</button>',
    })}`;
}

function invitesSection({ dashboard }) {
  const { invites } = dashboard;
  if (!invites.length) {
    return emptyState({ icon: 'bell', title: 'No pending invitations', message: 'Team invitations will appear here.' });
  }
  return `
    <div class="col" style="gap:11px">
      ${invites.map((i) => `
        <div class="approval-row pending">
          ${teamLogo({ name: i.squad_name, logo_url: i.logo_url }, 'lg')}
          <div class="grow" style="min-width:0">
            <div style="font-weight:650">${esc(i.squad_name)}</div>
            <div class="small muted">
              Invited as <span class="role-pill ${esc(i.role)}">${esc(i.role)}</span>
              ${i.invited_by_name ? ` by ${esc(i.invited_by_name)}` : ''}
            </div>
            ${i.message ? `<div class="tiny dim mt-1">"${esc(i.message)}"</div>` : ''}
          </div>
          <div class="row gap-sm">
            <button class="btn btn-sm" data-act="decline-invite" data-id="${i.id}">Decline</button>
            <button class="btn btn-sm btn-primary" data-act="accept-invite" data-id="${i.id}">Accept</button>
          </div>
        </div>`).join('')}
    </div>`;
}

function profileSection({ me, games }) {
  const p = me.profile || {};
  const socials = p.socials || {};
  const star = '<span class="req" title="Required">★</span>';

  return `
    <div class="grid grid-2" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)">
      <div class="card">
        <div class="card-head"><h2>Player profile</h2>
          <span class="small dim">${me.profile_complete ? 'Complete' : 'Incomplete'}</span>
        </div>
        <div class="card-body">
          <form id="profile-form" class="col" style="gap:14px">
            <div class="row" style="gap:14px;align-items:center">
              <label style="cursor:pointer" title="Upload a profile picture">
                <span class="player-avatar lg" id="avatar-preview">
                  ${p.avatar_url
                    ? `<img src="${esc(p.avatar_url)}" alt="" style="width:100%;height:100%;object-fit:cover">`
                    : esc((p.ign || me.user.name || '?').slice(0, 2).toUpperCase())}
                </span>
                <input type="file" accept="image/*" id="avatar-input" hidden>
              </label>
              <div class="small muted">Click the avatar to upload a picture.<br>PNG or JPG, up to 4 MB.</div>
            </div>

            <div class="grid grid-2" style="gap:14px">
              <div class="field">
                <label class="label required" for="p-name">Full Name${star}</label>
                <input class="input" id="p-name" name="full_name" value="${esc(p.full_name || me.user.name || '')}" required>
              </div>
              <div class="field">
                <label class="label required" for="p-ign">In-Game Name (IGN)${star}</label>
                <input class="input" id="p-ign" name="ign" value="${esc(p.ign || '')}" placeholder="e.g. SOULxMortal" required>
              </div>
              <div class="field">
                <label class="label required" for="p-phone">Phone Number${star}</label>
                <input class="input" id="p-phone" name="phone" type="tel" value="${esc(p.phone || '')}"
                       placeholder="+91 98765 43210" required>
                <span class="hint">Never shown publicly. Organizers use it to reach you.</span>
              </div>
              <div class="field">
                <label class="label" for="p-igid">In-Game ID</label>
                <input class="input" id="p-igid" name="in_game_id" value="${esc(p.in_game_id || '')}" placeholder="5123456789">
              </div>
              <div class="field">
                <label class="label" for="p-email">Email Address</label>
                <input class="input" id="p-email" value="${esc(me.user.email)}" disabled>
                <span class="hint">From your sign-in account.</span>
              </div>
              <div class="field">
                <label class="label" for="p-game">Main Game</label>
                <select class="select" id="p-game" name="game">
                  ${(games || ['BGMI']).map((g) => `<option value="${esc(g)}" ${p.game === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <label class="label" for="p-country">Country</label>
                <input class="input" id="p-country" name="country" value="${esc(p.country || '')}" placeholder="India">
              </div>
              <div class="field">
                <label class="label" for="p-region">State / City</label>
                <input class="input" id="p-region" name="region" value="${esc(p.region || '')}" placeholder="Maharashtra">
              </div>
              <div class="field">
                <label class="label" for="p-discord">Discord username</label>
                <input class="input" id="p-discord" name="discord" value="${esc(p.discord || '')}" placeholder="username">
              </div>
              <div class="field">
                <label class="label" for="p-alt">Alternate contact</label>
                <input class="input" id="p-alt" name="alt_contact" value="${esc(p.alt_contact || '')}" placeholder="Optional">
              </div>
            </div>

            <div class="divider"></div>
            <div class="label">Social links</div>
            <div class="grid grid-2" style="gap:14px">
              ${[['youtube', 'YouTube'], ['instagram', 'Instagram'], ['x', 'X / Twitter'], ['twitch', 'Twitch']].map(([key, label]) => `
                <div class="field">
                  <label class="label" for="p-${key}">${label}</label>
                  <input class="input" id="p-${key}" name="${key}" value="${esc(socials[key] || '')}" placeholder="https://">
                </div>`).join('')}
            </div>

            <div class="field">
              <label class="label" for="p-bio">Bio</label>
              <textarea class="textarea" id="p-bio" name="bio" rows="3">${esc(p.bio || '')}</textarea>
            </div>
          </form>

          <div class="row-between mt-3">
            <span class="small dim">${star} Required before you can be registered for a tournament.</span>
            <button class="btn btn-primary" data-act="save-profile" data-busy-label="Saving">Save profile</button>
          </div>
        </div>
      </div>

      <div class="col" style="gap:16px">
        <div class="card">
          <div class="card-head"><h2>Public profile</h2></div>
          <div class="card-body">
            <p class="small muted">This is what other players and organizers can see. Your phone number, email and alternate contact are never shown.</p>
            <a class="btn btn-block mt-2" href="/player/${me.user.id}">${icon('eye', 15)} View my public profile</a>
            <div class="divider"></div>
            ${shareBox(`/player/${me.user.id}`, { label: 'Share your profile' })}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Account</h2></div>
          <div class="card-body">
            <dl class="kv">
              <dt>Email</dt><dd>${esc(me.user.email)}</dd>
              <dt>Role</dt><dd>${esc((me.roles.find((r) => r.value === me.user.role) || {}).label || me.user.role)}</dd>
            </dl>
          </div>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- dialogs --
function createTeamDialog(ctx) {
  let logoData = null;
  modal({
    title: 'Create a team',
    body: html`
      <form id="team-create" class="col" style="gap:14px">
        <div class="row" style="gap:14px;align-items:flex-end">
          <label style="cursor:pointer" title="Upload a team logo">
            <span class="team-logo lg" id="squad-logo">${raw(icon('plus', 15))}</span>
            <input type="file" accept="image/*" id="squad-logo-input" hidden>
          </label>
          <div class="field grow">
            <label class="label required" for="s-name">Team name<span class="req">★</span></label>
            <input class="input" id="s-name" name="name" required placeholder="Alpha Wolves">
          </div>
          <div class="field" style="width:110px">
            <label class="label" for="s-tag">Tag</label>
            <input class="input" id="s-tag" name="tag" maxlength="8" placeholder="AW">
          </div>
        </div>
        <div class="grid grid-2" style="gap:14px">
          <div class="field">
            <label class="label" for="s-game">Game</label>
            <select class="select" id="s-game" name="game">
              ${raw(['BGMI', 'PUBG Mobile', 'Free Fire', 'Valorant', 'CS2'].map((g) => `<option>${g}</option>`).join(''))}
            </select>
          </div>
          <div class="field">
            <label class="label" for="s-region">Region</label>
            <input class="input" id="s-region" name="region" placeholder="India">
          </div>
        </div>
        <div class="field">
          <label class="label" for="s-bio">About the team</label>
          <textarea class="textarea" id="s-bio" name="bio" rows="2"></textarea>
        </div>
        <div class="info-box">
          ${raw(icon('info', 15))}
          <div>You become the captain and can invite players straight away.</div>
        </div>
      </form>`,
    footer: `
      <button class="btn" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="do-create" data-busy-label="Creating">Create team</button>`,
    onMount(overlay, close) {
      overlay.querySelector('#squad-logo-input').addEventListener('change', async (e) => {
        try {
          logoData = await readImage(e.target);
          if (logoData) overlay.querySelector('#squad-logo').innerHTML = `<img src="${logoData}" alt="" style="width:100%;height:100%;object-fit:cover">`;
        } catch (err) { toastError(err); }
      });

      overlay.querySelector('#do-create').addEventListener('click', async (e) => {
        const values = formData(overlay.querySelector('#team-create'));
        if (!values.name?.trim()) { toast('Give the team a name.', { type: 'error' }); return; }
        await withBusy(e.currentTarget, async () => {
          const res = await api.post('/api/squads', { ...values, logo_url: logoData || undefined });
          toast(`${res.squad.name} created. Invite your players next.`, { type: 'success' });
          close();
          ctx.navigate(`/team/${res.squad.slug}?manage=1`);
        });
      });
    },
  });
}

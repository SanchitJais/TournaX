/** Role-based access: platform users and per-tournament grants. */
import { api } from '../lib/api.js';
import { delegate, esc, formData, html, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { confirmAction, emptyState, modal, relativeTime, toast, toastError, withBusy } from '../lib/ui.js';

const ROLE_NOTES = {
  super_admin: 'Full access to everything, including user management.',
  tournament_admin: 'Manages teams, fixtures, results and settings for their tournaments.',
  scorekeeper: 'Enters and edits match results, and moves matches between statuses.',
  team_manager: 'Views their own team information and results.',
  spectator: 'Read-only access to public pages.',
};

export default {
  title: 'Access',

  async load(ctx) {
    // /admin/users (platform-wide) or /admin/t/:id/people (per-tournament).
    if (!ctx.params.id) {
      const users = await api.get('/api/users');
      return { platform: true, users: users.users, me: ctx.state.user };
    }
    const id = Number(ctx.params.id);
    const [members, teams] = await Promise.all([
      api.get(`/api/tournaments/${id}/members`),
      api.get(`/api/tournaments/${id}/teams`),
    ]);
    return { tournamentId: id, members: members.members, teams: teams.teams, me: ctx.state.user };
  },

  render(data) {
    return data.platform ? platformView(data) : tournamentView(data);
  },

  mounted(data, ctx, root) {
    delegate(root, {
      'add-user': () => userDialog({ data, ctx }),
      'edit-user': (el) => userDialog({ data, ctx, user: data.users.find((u) => u.id === Number(el.dataset.id)) }),
      'add-member': () => memberDialog({ data, ctx }),

      async 'delete-user'(el) {
        const user = data.users.find((u) => u.id === Number(el.dataset.id));
        const ok = await confirmAction({
          title: 'Delete user',
          message: `Delete the account for ${user.email}?`,
          detail: 'They lose access immediately. Tournaments they own are not deleted.',
          confirmLabel: 'Delete account',
        });
        if (!ok) return;
        try {
          await api.delete(`/api/users/${user.id}`);
          toast('User deleted.', { type: 'success' });
          ctx.navigate('/admin/users', { replace: true });
        } catch (err) { toastError(err); }
      },

      async 'remove-member'(el) {
        const ok = await confirmAction({
          title: 'Revoke access',
          message: `Remove ${el.dataset.name} from this tournament?`,
          confirmLabel: 'Revoke access',
        });
        if (!ok) return;
        try {
          await api.delete(`/api/tournaments/${data.tournamentId}/members/${el.dataset.id}`);
          toast('Access revoked.', { type: 'success' });
          ctx.navigate(`/admin/t/${data.tournamentId}/people`, { replace: true });
        } catch (err) { toastError(err); }
      },
    });
  },
};

// ------------------------------------------------------------------- views --
function platformView({ users, me }) {
  return html`
    <div class="page" style="max-width:1050px">
      <div class="page-head">
        <div class="page-title">
          <h1>Users</h1>
          <p class="muted small" style="margin:0">Platform-wide accounts and their default roles.</p>
        </div>
        <button class="btn btn-primary" data-act="add-user">${raw(icon('plus', 15))} Add user</button>
      </div>

      ${raw(roleLegend())}

      <div class="card mt-3">
        <div class="card-body tight">
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead>
              <tbody>
                ${raw(users.map((u) => `
                  <tr>
                    <td>
                      <div class="row" style="gap:9px">
                        <span class="avatar" style="width:26px;height:26px;flex-basis:26px;font-size:10.5px">
                          ${esc((u.name || '?').slice(0, 2).toUpperCase())}</span>
                        <span class="strong">${esc(u.name)}</span>
                        ${u.id === me?.id ? '<span class="badge badge-info">You</span>' : ''}
                        ${u.is_active ? '' : '<span class="badge badge-cancelled">Disabled</span>'}
                      </div>
                    </td>
                    <td class="small muted">${esc(u.email)}</td>
                    <td><span class="badge badge-active">${esc(roleLabel(u.role))}</span></td>
                    <td class="small dim">${u.last_login_at ? relativeTime(u.last_login_at, { assumeUtc: true }) : 'Never'}</td>
                    <td>
                      <div class="row gap-sm">
                        <button class="btn btn-ghost btn-icon" data-act="edit-user" data-id="${u.id}">${icon('edit', 14)}</button>
                        ${u.id === me?.id ? '' : `<button class="btn btn-ghost btn-icon" data-act="delete-user" data-id="${u.id}">${icon('trash', 14)}</button>`}
                      </div>
                    </td>
                  </tr>`).join(''))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
}

function tournamentView({ members, tournamentId }) {
  return html`
    <div class="page" style="max-width:1000px">
      <div class="page-head">
        <div class="page-title">
          <h1>Tournament access</h1>
          <p class="muted small" style="margin:0">
            Grant someone a role for this tournament only. It overrides their platform role here.
          </p>
        </div>
        <button class="btn btn-primary" data-act="add-member">${raw(icon('plus', 15))} Grant access</button>
      </div>

      ${raw(roleLegend())}

      <div class="card mt-3">
        <div class="card-head"><h2>People with access</h2></div>
        <div class="card-body tight">
          ${members.length ? raw(`
            <div class="table-wrap">
              <table class="data">
                <thead><tr><th>Name</th><th>Email</th><th>Role here</th><th>Team</th><th></th></tr></thead>
                <tbody>
                  ${members.map((m) => `
                    <tr>
                      <td class="strong">${esc(m.name)}</td>
                      <td class="small muted">${esc(m.email)}</td>
                      <td><span class="badge badge-active">${esc(roleLabel(m.role))}</span></td>
                      <td class="small">${m.team_name ? esc(m.team_name) : '<span class="dim">--</span>'}</td>
                      <td>
                        <button class="btn btn-ghost btn-icon" data-act="remove-member" data-id="${m.id}"
                                data-name="${esc(m.name)}">${icon('trash', 14)}</button>
                      </td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>`) : raw(emptyState({
              icon: 'users',
              title: 'Only you have access',
              message: 'Add a scorekeeper so someone else can enter results, or a team manager so a captain can follow their team.',
              action: `<button class="btn btn-primary mt-2" data-act="add-member">${icon('plus', 15)} Grant access</button>`,
            }))}
        </div>
      </div>
    </div>`;
}

const roleLegend = () => `
  <div class="card">
    <div class="card-body">
      <div class="grid grid-auto" style="gap:12px">
        ${Object.entries(ROLE_NOTES).map(([role, note]) => `
          <div>
            <span class="badge badge-active">${esc(roleLabel(role))}</span>
            <div class="tiny muted mt-1">${esc(note)}</div>
          </div>`).join('')}
      </div>
    </div>
  </div>`;

const roleLabel = (role) => ({
  super_admin: 'Super Admin', tournament_admin: 'Tournament Admin',
  scorekeeper: 'Scorekeeper', team_manager: 'Team Manager', spectator: 'Spectator',
}[role] || role);

// ----------------------------------------------------------------- dialogs --
function userDialog({ data, ctx, user = null }) {
  const isEdit = Boolean(user);
  modal({
    title: isEdit ? `Edit ${user.name}` : 'Add user',
    size: 'narrow',
    body: html`
      <form id="user-form" class="col" style="gap:13px">
        <div class="field">
          <label class="label" for="u-name">Name</label>
          <input class="input" id="u-name" name="name" value="${user?.name || ''}" required>
        </div>
        <div class="field">
          <label class="label" for="u-email">Email</label>
          <input class="input" id="u-email" name="email" type="email" value="${user?.email || ''}"
                 ${isEdit ? 'disabled' : 'required'}>
        </div>
        <div class="field">
          <label class="label" for="u-pass">${isEdit ? 'New password (optional)' : 'Password'}</label>
          <input class="input" id="u-pass" name="password" type="password" minlength="8"
                 placeholder="At least 8 characters" ${isEdit ? '' : 'required'}>
        </div>
        <div class="field">
          <label class="label" for="u-role">Role</label>
          <select class="select" id="u-role" name="role">
            ${raw(Object.keys(ROLE_NOTES).map((r) =>
              `<option value="${r}" ${user?.role === r ? 'selected' : ''}>${esc(roleLabel(r))}</option>`).join(''))}
          </select>
          <span class="hint" id="role-note">${esc(ROLE_NOTES[user?.role || 'spectator'])}</span>
        </div>
        ${isEdit ? raw(`
          <label class="check"><input type="checkbox" name="is_active" ${user.is_active ? 'checked' : ''}> Account is active</label>`) : ''}
      </form>`,
    footer: `
      <button class="btn" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="save-user" data-busy-label="Saving">${isEdit ? 'Save' : 'Create user'}</button>`,
    onMount(overlay, close) {
      const select = overlay.querySelector('#u-role');
      select.addEventListener('change', () => {
        overlay.querySelector('#role-note').textContent = ROLE_NOTES[select.value];
      });

      overlay.querySelector('#save-user').addEventListener('click', async (e) => {
        const values = formData(overlay.querySelector('#user-form'));
        if (!isEdit && (!values.email || !values.password)) {
          toast('Email and password are required.', { type: 'error' });
          return;
        }
        if (isEdit && !values.password) delete values.password;
        await withBusy(e.currentTarget, async () => {
          if (isEdit) await api.patch(`/api/users/${user.id}`, values);
          else await api.post('/api/users', values);
          toast(isEdit ? 'User updated.' : 'User created.', { type: 'success' });
          close();
          ctx.navigate('/admin/users', { replace: true });
        });
      });
    },
  });
}

function memberDialog({ data, ctx }) {
  modal({
    title: 'Grant tournament access',
    size: 'narrow',
    body: html`
      <p class="muted small">
        Enter an existing account's email, or supply a password to create the account at the same time.
      </p>
      <form id="member-form" class="col mt-2" style="gap:13px">
        <div class="field">
          <label class="label" for="m-email">Email</label>
          <input class="input" id="m-email" name="email" type="email" required placeholder="scorer@example.com">
        </div>
        <div class="field">
          <label class="label" for="m-role">Role for this tournament</label>
          <select class="select" id="m-role" name="role">
            <option value="scorekeeper">Scorekeeper -- enters results only</option>
            <option value="tournament_admin">Tournament Admin -- full control here</option>
            <option value="team_manager">Team Manager -- follows one team</option>
          </select>
        </div>
        <div class="field hidden" id="team-field">
          <label class="label" for="m-team">Team</label>
          <select class="select" id="m-team" name="team_id">
            <option value="">Choose a team</option>
            ${raw(data.teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join(''))}
          </select>
        </div>
        <div class="divider" style="margin:2px 0"></div>
        <div class="field">
          <label class="label" for="m-name">Name (only if creating the account)</label>
          <input class="input" id="m-name" name="name" placeholder="Rehan Qureshi">
        </div>
        <div class="field">
          <label class="label" for="m-pass">Password (only if creating the account)</label>
          <input class="input" id="m-pass" name="password" type="password" minlength="8" placeholder="At least 8 characters">
        </div>
      </form>`,
    footer: `
      <button class="btn" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="save-member" data-busy-label="Granting">Grant access</button>`,
    onMount(overlay, close) {
      const role = overlay.querySelector('#m-role');
      role.addEventListener('change', () => {
        overlay.querySelector('#team-field').classList.toggle('hidden', role.value !== 'team_manager');
      });

      overlay.querySelector('#save-member').addEventListener('click', async (e) => {
        const values = formData(overlay.querySelector('#member-form'));
        if (!values.email) { toast('An email address is required.', { type: 'error' }); return; }
        if (!values.password) delete values.password;
        if (values.role !== 'team_manager') delete values.team_id;
        await withBusy(e.currentTarget, async () => {
          await api.post(`/api/tournaments/${data.tournamentId}/members`, values);
          toast('Access granted.', { type: 'success' });
          close();
          ctx.navigate(`/admin/t/${data.tournamentId}/people`, { replace: true });
        });
      });
    },
  });
}

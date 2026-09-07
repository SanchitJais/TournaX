/** Sign-in / sign-up screen. */
import { api } from '../lib/api.js';
import { formData, html, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast, withBusy } from '../lib/ui.js';

export default {
  title: 'Sign in',

  render(_data, ctx) {
    const isRegister = location.pathname === '/register';
    return html`
      <div class="auth-screen">
        <div class="auth-card">
          <div class="auth-logo">
            <span class="brand-mark" style="width:48px;height:48px;border-radius:14px;font-size:19px">TM</span>
            <h1 style="font-size:22px">${isRegister ? 'Create your account' : 'Tournament Manager'}</h1>
            <p class="muted small center" style="margin:0">
              ${isRegister
                ? 'The first account on a new install becomes the super admin.'
                : 'Sign in to manage tournaments, fixtures and results.'}
            </p>
          </div>

          <div class="card">
            <div class="card-body">
              <form id="auth-form" class="col" style="gap:14px">
                ${isRegister ? raw(`
                  <div class="field">
                    <label class="label" for="name">Your name</label>
                    <input class="input" id="name" name="name" autocomplete="name" placeholder="Priya Nair" required>
                  </div>`) : ''}
                <div class="field">
                  <label class="label" for="email">Email</label>
                  <input class="input" id="email" name="email" type="email" autocomplete="email"
                         placeholder="you@example.com" required>
                </div>
                <div class="field">
                  <label class="label" for="password">Password</label>
                  <input class="input" id="password" name="password" type="password"
                         autocomplete="${isRegister ? 'new-password' : 'current-password'}"
                         placeholder="${isRegister ? 'At least 8 characters' : 'Your password'}" required
                         minlength="${isRegister ? 8 : 1}">
                </div>
                <button class="btn btn-primary btn-lg btn-block" type="submit" data-busy-label="Signing in">
                  ${isRegister ? 'Create account' : 'Sign in'}
                </button>
              </form>

              <div class="divider"></div>
              <div class="center small muted">
                ${isRegister
                  ? raw('Already have an account? <a href="/login" style="color:var(--primary-2)">Sign in</a>')
                  : raw('New here? <a href="/register" style="color:var(--primary-2)">Create an account</a>')}
              </div>
            </div>
          </div>

          ${isRegister ? '' : raw(demoHint())}
        </div>
      </div>`;
  },

  mounted(_data, ctx, root) {
    const form = root.querySelector('#auth-form');
    const isRegister = location.pathname === '/register';

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = form.querySelector('button[type=submit]');
      const payload = formData(form);
      await withBusy(button, async () => {
        const res = await api.post(isRegister ? '/api/auth/register' : '/api/auth/login', payload);
        ctx.state.user = res.user;
        ctx.state.role = res.user.role;
        toast(`Welcome, ${res.user.name}.`, { type: 'success' });
        ctx.navigate('/admin', { replace: true });
      });
    });

    root.querySelectorAll('[data-demo]').forEach((el) => {
      el.addEventListener('click', () => {
        form.querySelector('#email').value = el.dataset.demo;
        form.querySelector('#password').value = el.dataset.pass;
        form.querySelector('button[type=submit]').click();
      });
    });
  },
};

/** Only shown when the demo seed has been run. */
function demoHint() {
  return `
    <div class="card mt-2">
      <div class="card-body">
        <div class="row small muted" style="gap:7px">${icon('info', 15)} Demo accounts (after <span class="mono">npm run seed</span>)</div>
        <div class="col mt-2" style="gap:6px">
          ${[
            ['Super admin', 'admin@tournament.local', 'admin1234'],
            ['Organizer', 'organizer@tournament.local', 'organizer1234'],
            ['Scorekeeper', 'scorer@tournament.local', 'scorer1234'],
          ].map(([label, email, pass]) => `
            <button class="btn btn-sm" style="justify-content:space-between" data-demo="${email}" data-pass="${pass}">
              <span>${label}</span><span class="mono tiny dim">${email}</span>
            </button>`).join('')}
        </div>
      </div>
    </div>`;
}

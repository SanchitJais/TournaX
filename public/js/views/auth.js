/** Sign-in / sign-up screen. */
import { api } from '../lib/api.js';
import { esc, formData, html, raw } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast, withBusy } from '../lib/ui.js';

export default {
  title: 'Sign in',

  load: () => api.get('/api/auth/providers').catch(() => ({ google: false, password: true })),

  render(providers, ctx) {
    const isRegister = location.pathname === '/register';
    const error = new URLSearchParams(location.search).get('error');
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

          ${error ? raw(`<div class="warn-box mb-2">${icon('alert', 15)}<div>${esc(error)}</div></div>`) : ''}

          <div class="card">
            <div class="card-body">
              ${providers.google ? raw(`
                <a class="btn btn-lg btn-block" href="/api/auth/google" data-native="true">
                  ${googleMark()} Continue with Google
                </a>
                <div class="row mt-2 mb-2" style="gap:10px">
                  <span style="flex:1;height:1px;background:var(--border-soft)"></span>
                  <span class="tiny dim">or use email</span>
                  <span style="flex:1;height:1px;background:var(--border-soft)"></span>
                </div>`) : ''}

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

  mounted(providers, ctx, root) {
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
        // Organizers land in the admin area; players land on their own dashboard.
        const organiser = ['super_admin', 'organizer', 'tournament_admin', 'scorekeeper'];
        ctx.navigate(organiser.includes(res.user.role) ? '/admin' : '/me', { replace: true });
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

const googleMark = () => `
  <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-4H24v7.5h12c-.2 2-1.5 5-4.4 7l6.7 5.2C42.2 36 45 30.6 45 24z"/>
    <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.9-5.4c-1.9 1.3-4.4 2.2-7.6 2.2-5.8 0-10.7-3.9-12.5-9.1l-7.1 5.5C8 41.1 15.4 46 24 46z"/>
    <path fill="#FBBC05" d="M11.5 28.4c-.5-1.4-.7-2.9-.7-4.4s.3-3 .7-4.4l-7.1-5.5C2.9 17 2 20.4 2 24s.9 7 2.4 9.9l7.1-5.5z"/>
    <path fill="#EA4335" d="M24 10.8c3.3 0 6.2 1.1 8.5 3.3l6.3-6.3C34.9 4.1 29.9 2 24 2 15.4 2 8 6.9 4.4 14.1l7.1 5.5c1.8-5.2 6.7-8.8 12.5-8.8z"/>
  </svg>`;

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

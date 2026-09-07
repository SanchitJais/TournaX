/** Tournament registration, organizer approval, and check-in. */
import { all, get, run } from '../db.js';
import { requireAbility, requireUser } from '../auth.js';
import { badRequest, forbidden, notFound } from '../lib/http.js';
import { rateLimit } from '../lib/ratelimit.js';
import {
  checkIn, checkInWindow, decide, listRegistrations, myRegistration, noShows,
  register as submitRegistration, registrationCounts, registrationState, withdraw,
} from '../services/registrations.js';
import { isCaptain, squadsForUser } from '../services/squads.js';
import { loadTournament } from './tournaments.js';
import { recordAudit } from '../services/audit.js';
import { notify } from '../services/notify.js';

const registerLimiter = rateLimit('register', { limit: 12, windowMs: 10 * 60_000 });

export default function register(router) {
  /** Public: is registration open, how full is it, and am I already in? */
  router.get('/api/tournaments/:id/registration', (ctx) => {
    const tournament = loadTournament(Number(ctx.params.id));
    return registrationSummary(tournament, ctx.user);
  });

  router.get('/api/public/t/:slug/registration', (ctx) => {
    const tournament = get('SELECT * FROM tournaments WHERE slug = ? AND is_public = 1', [ctx.params.slug]);
    if (!tournament) throw notFound('Tournament not found');
    return registrationSummary(tournament, ctx.user);
  });

  /** Sign a team up. */
  router.post('/api/tournaments/:id/register', (ctx) => {
    const user = requireUser(ctx);
    registerLimiter(ctx);
    const tournament = loadTournament(Number(ctx.params.id));

    const squadId = Number(ctx.body.squad_id);
    if (!squadId) throw badRequest('Choose which team you are registering.');
    if (!isCaptain(squadId, user.id) && user.role !== 'super_admin') {
      throw forbidden('Only the team captain can register the team.');
    }

    const registration = submitRegistration({ tournament, squadId, user, notes: ctx.body.notes });
    return { __status: 201, registration, state: registrationState(loadTournament(tournament.id)) };
  });

  router.post('/api/tournaments/:id/registrations/:regId/withdraw', (ctx) => {
    const user = requireUser(ctx);
    const tournament = loadTournament(Number(ctx.params.id));
    return withdraw({ tournament, registrationId: ctx.params.regId, user });
  });

  // ------------------------------------------------------ organizer view --
  router.get('/api/tournaments/:id/registrations', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'registrations:write', tournamentId);
    const tournament = loadTournament(tournamentId);
    return {
      registrations: listRegistrations(tournamentId, { status: ctx.query.status || null }),
      counts: registrationCounts(tournamentId),
      state: registrationState(tournament),
      check_in: checkInWindow(tournament),
      no_shows: noShows(tournamentId),
    };
  });

  router.post('/api/tournaments/:id/registrations/:regId/decision', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'registrations:write', tournamentId);
    const tournament = loadTournament(tournamentId);
    const approve = ctx.body?.approve !== false;
    const registration = decide({
      tournament, registrationId: ctx.params.regId, approve,
      reason: ctx.body?.reason, actor: ctx.user,
    });
    return { registration, counts: registrationCounts(tournamentId) };
  });

  /** Approve or reject everything still pending, in one action. */
  router.post('/api/tournaments/:id/registrations/bulk', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'registrations:write', tournamentId);
    const tournament = loadTournament(tournamentId);
    const approve = ctx.body?.approve !== false;

    const pending = listRegistrations(tournamentId, { status: 'pending' });
    let done = 0;
    const errors = [];
    for (const registration of pending) {
      try {
        decide({ tournament, registrationId: registration.id, approve, reason: ctx.body?.reason, actor: ctx.user });
        done += 1;
      } catch (err) {
        errors.push(`${registration.team_name}: ${err.message}`);
      }
    }
    return { processed: done, errors, counts: registrationCounts(tournamentId) };
  });

  /** Open or close registration. */
  router.post('/api/tournaments/:id/registration/toggle', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'registrations:write', tournamentId);
    const open = ctx.body?.open !== false;
    run('UPDATE tournaments SET registration_open = ? WHERE id = ?', [open ? 1 : 0, tournamentId]);

    const tournament = loadTournament(tournamentId);
    recordAudit({
      tournamentId, actor: ctx.user, action: open ? 'registration.opened' : 'registration.closed',
      entity: 'tournament', entityId: tournamentId,
      summary: `Registration ${open ? 'opened' : 'closed'}.`,
    });
    notify({
      tournamentId, type: 'registration.received',
      title: open ? `Registration is open for ${tournament.name}` : `Registration closed for ${tournament.name}`,
      severity: open ? 'success' : 'info',
      link: `/tournament/${tournament.slug}`,
    });
    return { state: registrationState(tournament) };
  });

  // -------------------------------------------------------------- check-in --
  router.get('/api/tournaments/:id/check-in', (ctx) => {
    const tournament = loadTournament(Number(ctx.params.id));
    const mine = myRegistration(tournament.id, ctx.user?.id);
    return {
      window: checkInWindow(tournament),
      registration: mine,
      checked_in: Boolean(mine?.checked_in_at),
    };
  });

  router.post('/api/tournaments/:id/check-in', (ctx) => {
    const user = requireUser(ctx);
    const tournament = loadTournament(Number(ctx.params.id));

    const registration = ctx.body?.registration_id
      ? get('SELECT * FROM tournament_registrations WHERE id = ? AND tournament_id = ?',
        [Number(ctx.body.registration_id), tournament.id])
      : myRegistration(tournament.id, user.id);
    if (!registration) throw notFound('You do not have a registration for this tournament.');

    // A captain checks their own team in; an organizer can check anyone in.
    const mine = isCaptain(registration.squad_id, user.id);
    if (!mine) requireAbility(ctx, 'registrations:write', tournament.id);

    return {
      registration: checkIn({
        tournament, registrationId: registration.id, user,
        force: Boolean(ctx.body?.force) && !mine,
      }),
    };
  });

  /** Mark everyone who never checked in, so the organizer can act on no-shows. */
  router.post('/api/tournaments/:id/check-in/close', (ctx) => {
    const tournamentId = Number(ctx.params.id);
    requireAbility(ctx, 'registrations:write', tournamentId);
    const missing = noShows(tournamentId);
    if (ctx.body?.withdraw) {
      for (const registration of missing) {
        run("UPDATE tournament_registrations SET status = 'withdrawn' WHERE id = ?", [registration.id]);
        if (registration.team_id) run('DELETE FROM teams WHERE id = ?', [registration.team_id]);
      }
      recordAudit({
        tournamentId, actor: ctx.user, action: 'checkin.closed', entity: 'tournament', entityId: tournamentId,
        summary: `Closed check-in and removed ${missing.length} no-show team(s).`,
      });
    }
    return { no_shows: missing, removed: ctx.body?.withdraw ? missing.length : 0 };
  });
}

function registrationSummary(tournament, user) {
  const state = registrationState(tournament);
  const mine = myRegistration(tournament.id, user?.id);
  return {
    tournament: {
      id: tournament.id, slug: tournament.slug, name: tournament.name,
      game: tournament.game, banner_url: tournament.banner_url, logo_url: tournament.logo_url,
      prize_pool: tournament.prize_pool, start_date: tournament.start_date,
      match_format: tournament.match_format, format_type: tournament.format_type,
      entry_requirements: tournament.entry_requirements,
      min_players: tournament.min_players, max_players: tournament.max_players,
      organizer_name: tournament.organizer_name, region: tournament.region,
    },
    state,
    check_in: checkInWindow(tournament),
    my_registration: mine,
    my_squads: user ? squadsForUser(user.id).filter((s) => s.my_role === 'captain') : [],
    approved_teams: all(
      `SELECT r.team_name, s.slug, s.logo_url, s.tag, r.checked_in_at
         FROM tournament_registrations r LEFT JOIN squads s ON s.id = r.squad_id
        WHERE r.tournament_id = ? AND r.status = 'approved'
        ORDER BY r.created_at`,
      [tournament.id],
    ),
  };
}

/**
 * Notifications.
 *
 * Everything is written to the `notifications` table first -- that is the web
 * channel and the durable record. Outbound channels (email, Telegram, Discord,
 * WhatsApp) are pluggable transports registered here; none ship enabled, but
 * adding one is a `registerChannel` call rather than a change to any caller.
 */
import { all, insert, parseJson, run, toJson } from '../db.js';
import { DEFAULT_NOTIFICATION_PREFS, NOTIFICATION_EVENTS } from '../config.js';

/** name -> async ({ notification, tournament, prefs }) => void */
const channels = new Map();

export function registerChannel(name, send) {
  channels.set(name, send);
}

export const availableChannels = () => ['web', ...channels.keys()];

/**
 * Raise a notification for a tournament.
 * Silently does nothing when the organizer has muted that event type.
 */
export function notify({ tournamentId, type, title, body = null, link = null, severity = 'info', payload = null, prefs = null }) {
  const preferences = prefs || loadPrefs(tournamentId);
  if (NOTIFICATION_EVENTS[type] && preferences.events?.[type] === false) return null;

  const id = insert(
    `INSERT INTO notifications (tournament_id, type, title, body, link, severity, channel, payload, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, 'web', ?, datetime('now'))`,
    [tournamentId ?? null, type, title, body, link, severity, payload ? toJson(payload) : null],
  );

  // Fan out to any enabled external transport. Failures are logged, never
  // surfaced -- a Discord outage must not fail the organizer's result entry.
  for (const [name, send] of channels) {
    if (!preferences.channels?.[name]) continue;
    Promise.resolve()
      .then(() => send({ notification: { id, type, title, body, link, severity, payload }, tournamentId, prefs: preferences }))
      .catch((err) => console.error(`[notify] channel "${name}" failed:`, err.message));
  }
  return id;
}

function loadPrefs(tournamentId) {
  if (!tournamentId) return DEFAULT_NOTIFICATION_PREFS;
  const row = all('SELECT notification_prefs FROM tournament_settings WHERE tournament_id = ?', [tournamentId])[0];
  const parsed = parseJson(row?.notification_prefs, null);
  if (!parsed) return DEFAULT_NOTIFICATION_PREFS;
  return {
    events: { ...DEFAULT_NOTIFICATION_PREFS.events, ...(parsed.events || {}) },
    channels: { ...DEFAULT_NOTIFICATION_PREFS.channels, ...(parsed.channels || {}) },
  };
}

export function listNotifications(tournamentId, { limit = 50, unreadOnly = false } = {}) {
  const where = ['(tournament_id = ? OR tournament_id IS NULL)'];
  const params = [tournamentId];
  if (unreadOnly) where.push('read_at IS NULL');
  params.push(Math.min(200, limit));
  return all(
    `SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
    params,
  ).map((n) => ({ ...n, payload: parseJson(n.payload, null) }));
}

export const markRead = (ids) => {
  if (!ids?.length) return;
  run(
    `UPDATE notifications SET read_at = datetime('now') WHERE read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
};

export const markAllRead = (tournamentId) =>
  run(
    `UPDATE notifications SET read_at = datetime('now')
      WHERE read_at IS NULL AND (tournament_id = ? OR tournament_id IS NULL)`,
    [tournamentId],
  );

export const unreadCount = (tournamentId) =>
  all(
    'SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL AND (tournament_id = ? OR tournament_id IS NULL)',
    [tournamentId],
  )[0].n;

// ---------------------------------------------------------------------------
// Example transport, kept here as the shape future channels should follow.
// Enable by setting DISCORD_WEBHOOK_URL and turning the channel on in settings.
// ---------------------------------------------------------------------------
if (process.env.DISCORD_WEBHOOK_URL) {
  registerChannel('discord', async ({ notification }) => {
    await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `**${notification.title}**${notification.body ? `\n${notification.body}` : ''}`,
      }),
    });
  });
}

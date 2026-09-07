# Tournament Manager

A tournament management and fixture automation platform for esports — built around
BGMI/PUBG battle-royale scoring, but general enough for any team-based competition.

The organizer's job is reduced to two things: **create the tournament and enter the
teams**. Fixtures, points, rankings, tie-breaks, qualification and the next round are
all generated.

```
CREATE TOURNAMENT → ADD/IMPORT TEAMS → GENERATE FIXTURES → ENTER RESULTS
        → RANKINGS UPDATE → QUALIFICATION CALCULATED → GENERATE NEXT ROUND → FINALS
```

---

## Quick start

Requires **Node.js 22.5+** (uses the built-in `node:sqlite`). There are **no npm
dependencies** — nothing to install, works offline.

```bash
npm run seed      # creates data/tournament.db with a demo tournament
npm start         # http://localhost:3000
```

| URL | What |
|---|---|
| `http://localhost:3000/` | Public tournament browser |
| `http://localhost:3000/t/bgmi-pro-series-2026` | Public tournament page |
| `http://localhost:3000/admin` | Organizer dashboard |

### Demo accounts

| Role | Email | Password |
|---|---|---|
| Super Admin | `admin@tournament.local` | `admin1234` |
| Tournament Admin | `organizer@tournament.local` | `organizer1234` |
| Scorekeeper | `scorer@tournament.local` | `scorer1234` |
| Team Manager | `manager@tournament.local` | `manager1234` |

On a *fresh* install with no seed, the first account registered at `/register`
automatically becomes the super admin.

Other commands:

```bash
npm test              # 29 API + 22 unit tests
npm run dev           # auto-restart on change
npm run reset         # wipe and reseed the database
PORT=8080 npm start   # different port
DB_PATH=/tmp/x.db npm start
```

---

## The automation, in detail

### Fixture generation

`POST /api/stages/:id/fixtures/generate` draws a complete schedule from the team
list. Four formats are supported:

- **Battle royale** — teams are placed into lobbies of *N*. Two modes:
  - *Rotating* (default): teams are redrawn every round so they meet as many
    different opponents as possible.
  - *Static*: fixed groups that stay together all tournament.
- **Round robin** — circle-method pairings; everyone plays everyone once (or twice),
  with byes handled for odd team counts.
- **Single elimination** — standard seeded bracket (1v16, 8v9, …) with automatic byes.
- **Groups + knockout** — round-robin groups feeding a bracket.

The rotating draw is the interesting one. Repeated match-ups are minimised by
modelling the draw as a cost problem — the cost of a schedule is
`Σ C(times each pair met, 2)` — and minimising it with randomised restarts, local
search, and a final pass that re-optimises each round against all the others.

It is provably optimal for the common cases. For 24 teams in two lobbies of 12 over
3 rounds, each team's lobby assignment is a 3-bit signature; with 8 signatures and 24
teams the best possible split is 3 teams per signature, giving cost 180. The generator
reaches exactly 180 on every seed. Same for 32 teams over 4 rounds (optimum 672).
Both are asserted in [`test/fixtures.test.js`](test/fixtures.test.js). Larger fields
run under a wall-clock budget (default 700 ms) so a 100-team draw still returns
promptly.

Draws can be **previewed** before saving, **regenerated** if the organizer dislikes
the result, and made **reproducible** by fixing the RNG seed.

### Scoring and rankings

Results are entered as *placement, kills, bonus, penalty*. Everything else is
computed:

```
total = placement points + kill points + bonus − penalty
```

Points columns can still be overridden per row for replays and agreed corrections.

**Rankings are never stored.** `computeStandings()` aggregates `match_results` at read
time, so editing one result silently and correctly rewrites the whole table — there is
no cached ranking that can drift. Tie-breakers are an ordered, organizer-editable list
(total points → kills → wins → best placement → …), applied top-down.

### Qualification and progression

The cut is recomputed live from the standings, so the organizer watches it move as
results come in. "Lock qualification" snapshots it and stamps team statuses;
"Generate Next Round" then creates the next stage, carries the qualified teams across
seeded by finishing position, and draws its fixtures. Match numbering stays continuous
across the whole tournament.

---

## Architecture

```
server.js              HTTP server (node:http), static files, SPA fallback
src/
  schema.sql           18-table relational schema
  db.js                node:sqlite connection, transactions, JSON helpers
  auth.js              scrypt passwords, sessions, role/ability checks
  config.js            defaults, vocabularies, built-in templates
  router.js            pattern router
  routes/              auth, tournaments, teams, matches, insights, exports, public
  services/
    fixtures.js        pure draw algorithms (no database)
    scheduler.js       commits a draw to the database
    scoring.js         points calculation
    leaderboard.js     derived standings + tie-breakers
    qualify.js         live cut + locking
    progression.js     "generate next round"
    notify.js          notifications + pluggable channels
    audit.js           change history
  lib/
    xlsx.js            XLSX reader/writer built on node:zlib
    pdf.js             PDF generator (Helvetica metrics, pagination)
    csv.js             RFC-4180 CSV
    http.js            body parsing, cookies, static, image uploads
public/
  index.html           app shell
  css/app.css          design system
  js/main.js           router + admin chrome
  js/lib/              dom (escaping template tag), api, ui kit, icons
  js/views/            one module per screen
```

**No build step.** The frontend is native ES modules; edit and reload.

### Why no dependencies

Node 22.5+ ships `node:sqlite`, so the relational database needs no native module
(and no compiler on Windows). `node:zlib` makes real `.xlsx` files possible — an xlsx
is a ZIP of XML — and PDF is a plain text format, so both exports are written directly.
The result installs in zero seconds and has no supply chain.

### Security notes

- Passwords are scrypt-hashed with a per-user salt; comparison is timing-safe.
- Sessions are httpOnly, SameSite=Lax cookies, expired hourly.
- All interpolated values in the frontend are HTML-escaped by default (the `html`
  tagged template); `raw()` marks the deliberate exceptions.
- Static file serving is containment-checked against `public/`.
- Room IDs and passwords are withheld from public responses until their reveal time.
- Captain contact details are never exposed on public endpoints.

---

## Roles

| Role | Can |
|---|---|
| **Super Admin** | Everything, including user management |
| **Tournament Admin** | Teams, fixtures, results, settings for their tournaments |
| **Scorekeeper** | Enter/edit results, change match status — nothing else |
| **Team Manager** | View their team's information and results |
| **Spectator** | Public read-only |

Roles can be granted globally or **per tournament** (`tournament_members`), which
overrides the global role in that tournament. Tournament owners always have full
control of their own events.

---

## Import / export

**Import** — `.xlsx` or `.csv`, uploaded or pasted. Column names are matched
flexibly: `Team Name`, `team`, `Squad Name` and `Clan` all work, as do
`Player 1..8` / `Player 1 IGN`, or a single comma-separated `Players` column.
Re-importing the same sheet updates rather than duplicating. Groups named in the
sheet are created automatically.

**Export** — every dataset as CSV, Excel or PDF:

```
/api/tournaments/:id/export/leaderboard.pdf
/api/tournaments/:id/export/schedule.xlsx
/api/tournaments/:id/export/teams.csv
/api/tournaments/:id/export/results.xlsx
/api/tournaments/:id/export/tournament.json   ← full backup
/api/tournaments/:id/export/tournament.xlsx   ← every sheet in one workbook
```

---

## Extending it

### Notification channels

Web notifications work out of the box. Other channels are transports registered
against the same dispatcher — no caller changes:

```js
// src/services/notify.js
registerChannel('telegram', async ({ notification, tournamentId }) => {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { ... });
});
```

A Discord webhook transport ships as a worked example — set `DISCORD_WEBHOOK_URL`
and enable the channel in Settings → Notifications. Failures are logged and never
break the organizer's action.

### What the schema already supports

The schema was designed for the roadmap features: `player_stats` backs MVP and kill
leaderboards, `prize_pool` and `sponsor`-style branding fields exist on tournaments,
multiple simultaneous tournaments already work, and every endpoint is a clean JSON API
that a public API, Discord bot or QR registration flow can call directly.

---

## Testing

```bash
npm test
```

- **`test/fixtures.test.js`** — draw quality against proven optima, round-robin
  completeness, bracket seeding, byes, scheduling, determinism, time budget.
- **`test/api.test.js`** — boots a real server against a throwaway database and walks
  the whole organizer journey, including permission denials, credential reveal
  timing, and export file signatures.
- **`test/xlsx.test.js` / `test/pdf.test.js`** — round-trips and format validity
  (the PDF test verifies every xref offset points at its object).

---

## Database

18 tables: `users`, `sessions`, `tournaments`, `tournament_settings`,
`tournament_members`, `stages`, `groups`, `teams`, `players`, `rounds`, `matches`,
`match_participants`, `match_results`, `player_stats`, `qualifications`,
`notifications`, `audit_logs`, `templates`.

See [`src/schema.sql`](src/schema.sql). Foreign keys are on and cascade, so deleting a
tournament removes everything beneath it cleanly.

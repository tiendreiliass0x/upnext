# UP/NEXT

A mobile-first DJ room where guests scan a QR code, listen to 30-second song
previews, and vote the queue into order.

## Stack

- Next.js 15 and React 19
- SQLite through `better-sqlite3`
- Cloudflare R2 for private preview audio
- FFmpeg for server-side 30-second MP3 previews

## Local Setup

1. Copy `.env.example` to `.env` and add R2 S3 credentials.
2. Install dependencies with `bun install`.
3. Start the app with `bun run dev`.

SQLite defaults to `data/dj-booth.sqlite`. The directory and database are
created automatically.

Set `APP_PUBLIC_URL` to the address guests will use. Guest links and the QR
code are built from it. Without it they fall back to whatever address the DJ
opened the booth on, and that address is usually wrong for guests: a LAN IP
resolves only on the venue's own wifi, so anyone on mobile data cannot load it,
and `localhost` resolves to the guest's own phone, so every scan fails. The
live room refuses to render a QR code for a loopback address and flags a
same-network one rather than handing out a code that cannot work. To test from
another network, run a tunnel (`cloudflared tunnel --url http://localhost:3000`)
and set `APP_PUBLIC_URL` to the hostname it prints.

bun is the package manager and `bun.lock` is the only lockfile. Node stays the
runtime: `better-sqlite3` ships a Node-ABI native binding that bun's runtime
refuses to load, so Next.js, Vitest and the cleanup script all execute under
Node. `bun run <script>` is the right way to invoke them — it resolves the
binary and spawns it under Node.

## Voting Identity

QR guests receive a browser voter ID in local storage and can cast one free
vote per room without onboarding. A second pick asks for a private phone number
and either account creation or login; both transfer the free vote before saving
the next one. Clearing browser storage can create a new voter ID, so this is a
best-effort device limit until phone verification is added.

## Tests

- `bun run test` runs the isolated unit, API, component, R2-mock, and FFmpeg suites.
- `bun run test:coverage` enforces the repository coverage baseline.
- `bun run test:r2` runs the opt-in live R2 upload/download/delete check using
  the configured `.env` credentials.

## Cleanup

Ended and expired rooms, their tracks and votes, and the R2 previews they held
open are all reclaimed by `bun run cleanup`. Nothing removes them otherwise, so
schedule it — an hourly cron entry or systemd timer next to the app process is
enough:

```
0 * * * * /srv/upnext/scripts/run-cleanup.sh >> /var/log/upnext-cleanup.log 2>&1
```

Schedule `scripts/run-cleanup.sh` rather than `bun run cleanup`. A scheduler
gives the job a minimal PATH, so the wrapper resolves the interpreter itself:
it reads nvm's default alias, refuses any Node older than 22.9 (the cleanup
script passes `--env-file-if-exists`), and exits non-zero with a readable
message instead of failing obscurely. `scripts/run-cleanup.sh --print-node`
reports which interpreter a scheduled run would pick, without running the job.
`bun run cleanup` remains the interactive entry point.

A failed run posts a macOS notification and records the reason under
`~/Library/Application Support/com.upnext.cleanup`, so the failure survives a
banner that was missed or suppressed by a Focus mode.
`scripts/run-cleanup.sh --status` prints last success, last failure and the log
size. Set `UPNEXT_CLEANUP_NOTIFY=0` to silence banners (they are skipped
automatically where `osascript` does not exist, such as a Linux server).

The wrapper also caps the log, which launchd appends to forever and never
rotates: one generation at 1 MB, so the pair is bounded at ~2 MB.

This does not detect the job never running at all. Nothing self-hosted can —
if the agent is unloaded, no code of ours executes. Gap-alerting from a
heartbeat was considered and rejected: an hourly job on a laptop legitimately
misses every run during sleep, so it would fire every morning and be ignored.
A true dead-man switch needs an external monitor that expects a periodic
check-in, which is what `CLEANUP_MONITOR_URL` is for. Create a check at
healthchecks.io, a self-hosted Healthchecks, Cronitor or Better Stack, and put
its ping URL in `.env`. The wrapper hits `<url>/start` before the run, the base
URL on success, and `<url>/fail` on failure — the convention all of those
services accept. The monitor alerts when an expected check-in does not arrive,
which is the one failure mode nothing on this machine can report.

Unset, no request is made. A monitor that is unreachable logs a warning and
never fails the run itself. The success check-in carries the summary, which is
counts and booleans only; failure output is withheld unless
`CLEANUP_MONITOR_SEND_OUTPUT=1`, since stack traces can carry absolute paths.
The URL is a credential — it lives in `.env`, is never logged, and `--status`
shows only its host.

Retention is controlled by `CLEANUP_ROOM_RETENTION_HOURS` and
`CLEANUP_UPLOAD_GRACE_HOURS` (the grace period covers a DJ who uploaded previews
but has not opened the room yet). Both ship set to 24 hours in `.env.example`;
with neither set the built-in fallbacks are 7 days and 24 hours. The command prints a JSON summary and
exits non-zero when any object could not be deleted.

Objects are always removed from R2 before their database row, so an interrupted
run leaves a row for the next run to retry rather than an object nothing points
at. The job is safe to run while the app is serving traffic and safe to re-run.

## Production

Run the app as one long-lived Node process and set `SQLITE_PATH` to a mounted,
persistent disk. The current SQLite and FFmpeg architecture is not compatible
with stateless or read-only serverless functions such as Vercel Functions.

R2 objects are private. The app returns short-lived signed URLs for active-room
previews only.

Phone login is intentionally unverified in this MVP: entering a registered
number returns that account's token on any device. SMS OTP verification must be
added before production because phone-number knowledge alone does not prove
account ownership.

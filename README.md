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
2. Install dependencies with `npm install`.
3. Start the app with `npm run dev`.

SQLite defaults to `data/dj-booth.sqlite`. The directory and database are
created automatically.

## Voting Identity

QR guests receive a browser voter ID in local storage and can cast one free
vote per room without onboarding. A second pick asks for a private phone number
and either account creation or login; both transfer the free vote before saving
the next one. Clearing browser storage can create a new voter ID, so this is a
best-effort device limit until phone verification is added.

## Tests

- `npm test` runs the isolated unit, API, component, R2-mock, and FFmpeg suites.
- `npm run test:coverage` enforces the repository coverage baseline.
- `npm run test:r2` runs the opt-in live R2 upload/download/delete check using
  the configured `.env` credentials.

## Cleanup

Ended and expired rooms, their tracks and votes, and the R2 previews they held
open are all reclaimed by `npm run cleanup`. Nothing removes them otherwise, so
schedule it — an hourly cron entry or systemd timer next to the app process is
enough:

```
0 * * * * cd /srv/upnext && npm run cleanup >> /var/log/upnext-cleanup.log 2>&1
```

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

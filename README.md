# UP/NEXT

A mobile-first DJ room where guests scan a QR code, listen to the song
previews, and vote the queue into order.

## Stack

- Next.js 15 and React 19
- SQLite through `better-sqlite3`
- Cloudflare R2 for private preview audio

## Local Setup

1. Copy `.env.example` to `.env` and add R2 S3 credentials.
2. Install dependencies with `bun install`.
3. Start the app with `bun run dev`.

SQLite defaults to `data/dj-booth.sqlite`. The directory and database are
created automatically.

Stop `bun run dev` before running `bun run build`. Both write `.next`, and a
build that runs alongside the dev server fails with `Cannot find module for
page` on whichever routes the dev server happened to be rewriting. Nothing is
wrong with the code when that happens.

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

## Audio Storage and Streaming

Uploads are stored in R2 exactly as the DJ sent them — no browser trim, no
server re-encode. The earlier design cut every song to a 30-second 128 kbps
clip, first in the browser (a full decode to PCM plus an MP3 encode on the main
thread, which is what froze the booth tab for seconds per song) and then again
with ffmpeg on the server. Both passes are gone: the audience wanted full songs,
and the CPU cost bought nothing once the clip was the product's ceiling.

What replaced ffmpeg's implicit format check is a sniff of the file's leading
bytes (`src/lib/audio.ts`): MP3, WAV, FLAC, OGG, M4A/AAC and AIFF are accepted
by their container signature, everything else is refused regardless of its
name. That keeps non-audio out of the bucket; it does not prove a file decodes,
so a corrupt song fails at play time rather than at upload.

Playback streams straight from R2. A track's `/preview` route answers with a
307 to a signed R2 URL, and the browser fetches the song from there with Range
requests as it plays, so seeking and long tracks cost the app server nothing.
The signature lasts an hour — it has to outlive the longest song plus a pause,
because every later Range request reuses the same URL.

The upload limit is 60 MB per file (a long lossless track), and Caddy's
`request_body.max_size` sits just above it so the proxy never answers a 413
before the app can explain one. The body streams to R2 with its length
declared rather than being buffered a second time, and uploads are serialized
per account so a burst cannot exhaust a small VPS. A dropped connection does
*not* cancel the PUT: by then the body has already been received, so finishing
and registering it makes the DJ's retry (same upload ID) instant rather than
another 60 MB, and cleanup reaps it if they never come back.

Storage is the cost that scales, and a library track pins its upload for good,
so each account has a ceiling: **1 GB by default** (`UPLOAD_QUOTA_MB`), about
eighty MP3s or twenty long WAVs, enforced from the `size_bytes` column on
`audio_uploads` before the PUT. Uploads are also rate limited to 60 per account
per hour. Both exist because accounts are self-registered and unverified.

Signed read URLs last **15 minutes**: long enough for any song plus a pause,
because every Range request during playback reuses the same URL, and no longer,
because for that window the link is a credential-free download anyone can be
sent. Guest playback of full songs is the product; the TTL is the only dial
there. If DJs upload licensed masters, that exposure is theirs to weigh.

Clips from before this change (object keys under `previews/`) are 30 seconds
and were never stored at full length. On start-up the catalogue drops its
claim on them so they show as "no audio" instead of stopping short; the clips
themselves are reaped by cleanup once nothing holds them. Re-upload the songs.

Internally the object-key columns are still called `preview_key`. Renaming a
storage column across every table, the cleanup job and its tests would be a
migration with real risk and no user-visible gain, so the name stays with a
comment.

## Song Libraries

Set `ADMIN_TOKEN` and visit `/admin` to create named libraries and upload songs
into them. Each upload runs through the same sniff-and-store R2 pipeline as a DJ's
own files, so catalogue songs carry real audio.

In the DJ booth, a picker above the upload zone lets a DJ choose a library,
search it, and tick songs into the queue. A catalogue song is never re-uploaded:
it already has a preview, and the room reuses that object. DJs can also add
songs they have uploaded, so the catalogue grows from use; removal is
admin-only, which is the moderation lever.

`ADMIN_TOKEN` is separate from the phone login on purpose. Phone login is
unverified, so anyone who knows a registered number holds that account —
hanging the catalogue off it would make the most privileged surface the easiest
to take over. Unset, `/admin` reports itself as absent rather than as forbidden.

Cleanup treats a library entry as a claim on its preview, so catalogue audio
outlives the rooms that used it. Deleting the entry releases the claim, and the
next run reclaims the object.

## Play

`/play` is the listening side of the catalogue. Search every library at once,
audition songs inline, and collect them into playlists. The song currently
playing stays docked at the bottom of the page with transport controls and a
progress bar, and playback advances through whatever list it was started from.

Playlists belong to the account that made them. Every query is scoped by
account, and another DJ's playlist answers 404 rather than 403 — whether it
exists is not information they are entitled to. A playlist points at catalogue
entries rather than copying them, so when an admin removes a song it leaves
every playlist that held it; removal stays a real moderation lever. An account
holds at most 100 playlists and a playlist at most 500 songs; past that the API
answers 409 rather than growing without limit.

"Start a room from this playlist" opens the booth at `/?playlist=<id>` with the
draft seeded from the playlist: the room takes the playlist's name and its
songs, already carrying their catalogue previews so nothing re-uploads. The DJ
can still rename, reorder, or drop songs before going live; the room is not
created until they do, which is also why an existing live room is never
doubled by a second one.

The preview endpoint is account-gated and an `<audio>` element cannot send a
bearer header, so the player asks for the signed URL as JSON (`?as=json`) and
sets that on the element. The redirect form still works for anything that
follows redirects.

Songs play in full, so a playlist here is a listenable set, not just an audition.

## Now Playing

The live booth has a **Now playing** panel with one main action: *Play crowd
pick*, which puts on the top-voted song that is not on cooldown. The DJ can
also take a song off. Each change stamps the track as played and bumps the
room revision, so every guest's next poll carries it.

A played song is not gone for good — people may want to hear it again — but it
sits out on a **cooldown** until two other songs have rolled. While cooling it
sinks below the ballot, its row says how many songs are left, and a vote on it
is refused with *"Cooldown — try again after two/one more song(s) have
rolled."* (409, code `COOLDOWN`). Its votes are spent when it plays: account
votes are removed so the same people can vote it back up, and an anonymous
guest's one free vote stays used but stops counting. So a song comes back on
fresh votes, never on the ones that already got it played. The "crowd pick"
shown to guests is always the first song that is off cooldown.

Guests see the song docked under the ballot with a *Listen along* button.
Browsers refuse unprompted audio, so the first song needs a tap; after that a
change of song follows automatically. A late joiner starts partway through,
offset by how long the DJ has had the song on, so a phone roughly tracks the
room rather than restarting from the top. This is phone playback of the same
file, not a synced broadcast — expect drift of a second or two. A joiner who
arrives after the song has run out is told it has finished rather than hearing
it restart, and the dock stays unlocked while the DJ has nothing on, so the
next song still follows without another tap. The server refuses a new vote on
a played track (409), since a guest's ballot can be up to one poll behind.

## Voting Identity

QR guests receive a browser voter ID in local storage and can cast one free
vote per room without onboarding. A second pick asks for a private phone number
and either account creation or login; both transfer the free vote before saving
the next one. Clearing browser storage can create a new voter ID, so this is a
best-effort device limit until phone verification is added.

## Tests

- `bun run test` runs the isolated unit, API, component, R2-mock, and format-sniff suites.
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

## Deploying

The app needs a long-lived process and a writable disk, so it runs as a container behind Caddy on any small VPS. `Dockerfile`,
`docker-compose.yml` and `Caddyfile` are in the repo.

Build on the server, not on your laptop. `better-sqlite3`
resolve to platform-specific binaries at install time, and a macOS build cannot
run in a Linux image. Give the box at least 2 GB of RAM: `next build` is the
memory-hungry step, not serving.

`deploy/provision.sh` does the whole thing on a fresh Debian or Ubuntu box:
swap if the RAM is tight, Docker, a firewall, the stack itself, and the hourly
cleanup cron. It is idempotent, so re-run it to redeploy after a `git pull`;
a hostname already in `.env` is kept unless you pass `--host` again.

```
git clone <repo> /srv/upnext && cd /srv/upnext
sudo bash deploy/provision.sh --dry-run     # see the plan, change nothing
sudo bash deploy/provision.sh               # hostname derived from the public IP
```

It stops before starting anything if R2 credentials are missing from `.env`,
rather than bringing up a room whose uploads fail at the last step. Add them
and run it again. Pass `--host dj.example.com` once you have a domain;
otherwise it derives an sslip.io hostname from the machine's own address
without contacting any outside service.

Or, by hand:

```
cp .env.example .env      # add R2 credentials
echo 'SITE_ADDRESS=203-0-113-4.sslip.io'           >> .env
echo 'APP_PUBLIC_URL=https://203-0-113-4.sslip.io' >> .env
docker compose up -d --build
```

Caddy obtains a certificate on first request, so the QR link is HTTPS with no
further setup. sslip.io is a shared domain and Let's Encrypt rate-limits per
registered domain, so if issuance fails you are queued behind other users of
it — a cheap domain of your own avoids that permanently.

Schedule cleanup from the host, since the container has no cron, and rotate
its log there too (`provision.sh` installs both, plus an `/etc/logrotate.d`
entry; the wrapper's own log cap only applies where it owns the log file):

```
0 * * * * cd /srv/upnext && docker compose exec -T app ./scripts/run-cleanup.sh >> /var/log/upnext-cleanup.log 2>&1
```

`docker-compose.yml` points `UPNEXT_CLEANUP_STATE` at the data volume so
`run-cleanup.sh --status` survives a redeploy.

**Do not scale the app service past one replica.** Vote counts live in a SQLite
file and the upload concurrency limit is an in-process `Set`, so a second
replica would split the limiter and corrupt the counts.

### Continuous deployment

Merging to `main` runs CI (types, lint, tests with coverage thresholds,
production build, Docker build), then builds the image on GitHub, pushes it to
`ghcr.io/tiendreiliass0x/upnext` as `sha-<commit>` and `latest`, and rolls it
out over SSH: the VPS pulls that exact tag, restarts, waits for the container
healthcheck, and rolls back to the previous tag if it never goes healthy.
Building on GitHub rather than on the VPS is deliberate — `next build` on a
1–2 GB box is the slowest and least reliable step of a deploy.

It needs four repository secrets — `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`
(private ed25519 key whose public half is in that user's
`~/.ssh/authorized_keys`), and optionally `VPS_KNOWN_HOSTS` from
`ssh-keyscan <host>` — plus the variable `VPS_APP_DIR` if the checkout is not
at `/opt/upnext`. Until `VPS_HOST` is set the workflow only pushes the image.
The rollout script is `deploy/rollout.sh`; see `CONTRIBUTING.md` for the
branch workflow and how to roll back by hand.

## Production

Run the app as one long-lived Node process and set `SQLITE_PATH` to a mounted,
persistent disk. The current SQLite-on-disk architecture is not compatible
with stateless or read-only serverless functions such as Vercel Functions.

R2 objects are private. The app returns short-lived signed URLs for active-room
previews only.

Phone login is intentionally unverified in this MVP: entering a registered
number returns that account's token on any device. SMS OTP verification must be
added before production because phone-number knowledge alone does not prove
account ownership.

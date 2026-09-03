# UP/NEXT

A mobile-first DJ room where guests scan a QR code, hear what the DJ has on,
and vote the queue into order.

## Stack

- Next.js 15 and React 19
- SQLite through `better-sqlite3`
- Cloudflare R2 for private preview audio

## Local Setup

1. Copy `.env.example` to `.env` and add R2 S3 credentials.
2. Install dependencies with `bun install`.
3. Start the app with `bun run dev`.

Local development listens on `:3003`, leaving `:3000` available for the
separate `upnext-serve` production checkout.

Deploy the latest `main` build to that production checkout with:

```bash
bun run deploy
```

The command pulls `~/dev/upnext-serve`, builds in a temporary directory,
restarts its LaunchAgent, checks port `3000`, and restores the previous build
if the new one does not become healthy. Set `UPNEXT_SERVE_DIR` when the
production checkout lives somewhere else.

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
same-network one rather than handing out a code that cannot work.

### Reaching the dev server from another network

`dev.younext.dev` is a named Cloudflare tunnel (`upnext-dev`) into the dev
server on `:3003`. Its config and credentials live in `~/.cloudflared/` on the
DJ's laptop, outside the repo, because the credentials file is a secret. It runs
as a launchd service (`cloudflared service install`), so it is up whenever the
laptop is; `cloudflared tunnel run upnext-dev` runs it in the foreground
instead. Set `APP_PUBLIC_URL=https://dev.younext.dev` so guest links and the QR
code point there. The hostname is listed in `allowedDevOrigins` in
`next.config.ts` next to the LAN addresses, which is what lets hot reload work
through the tunnel: Next refuses its dev websocket to any origin it was not
told about, and a browser arriving through a tunnel presents the tunnel's
hostname, not a LAN IP.

Each machine that runs the booth gets its own tunnel and hostname
(`sound.younext.dev` is the second one), because one tunnel with two
connectors round-robins requests between them, and two dev servers do not
share a database. On the new machine: `cloudflared tunnel login`,
`cloudflared tunnel create <name>`, `cloudflared tunnel route dns <name>
<host>.younext.dev`, the same `config.yml` with `127.0.0.1:3003` as the
service, `cloudflared service install`, that machine's `APP_PUBLIC_URL`, and
the hostname added to `devTunnelHosts` in `next.config.ts`. A quick tunnel (`cloudflared tunnel --url ...`) still
works for a one-off, but its random hostname is not on that list, so pages
load and hot reload does not.

bun is the package manager and `bun.lock` is the only lockfile. Node stays the
runtime: `better-sqlite3` ships a Node-ABI native binding that bun's runtime
refuses to load, so Next.js, Vitest and the cleanup script all execute under
Node. `bun run <script>` is the right way to invoke them — it resolves the
binary and spawns it under Node. `.nvmrc` pins the Node major (24), the same
one CI and the image use; `nvm use` in the repo picks it up. Keep the three in
step: a native binding built for one major will not load under another. An
older Node does not fail politely here — better-sqlite3 13 needs N-API 10, and
Node 22 segfaults loading it, silently, on the first database call — so
`next.config.ts` refuses to start on anything below 24 and says why. If a
terminal was open before the nvm default moved, `nvm use` fixes its PATH.

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
307 to a signed R2 URL, but only for the song the DJ currently has on: the
room listens to the broadcast, it does not browse the masters, so a guest who
constructs another track's URL from the payload gets a 404. The DJ can
pre-listen to any row in the live booth: the client sends the room's host key
in the `x-upnext-host-key` header (never a query string, so it stays out of
access logs) and asks for the signed URL with `?as=json`, since an `<audio>`
element cannot carry headers. From the signed
URL the browser fetches the song with Range
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

## Connected Accounts

A DJ can link their own SoundCloud account and build a room from playlists they
already made, instead of re-uploading the set. The picker sits beside the
library picker in setup step 02.

Set `SOUNDCLOUD_CLIENT_ID`, `SOUNDCLOUD_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`
and `APP_PUBLIC_URL`. With any of them missing the picker reports itself
unavailable rather than showing a button that cannot work.

Registration is self-serve at
<https://developers.soundcloud.com/docs/api/register-app>, but it requires an
active SoundCloud Artist Pro subscription. The redirect URI must be registered
there character for character and is derived from `APP_PUBLIC_URL` as
`<APP_PUBLIC_URL>/api/connections/soundcloud/callback` — in development,
`http://127.0.0.1:3003/api/connections/soundcloud/callback`.

Generate the sealing key with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Rotating it does not corrupt anything: existing connections read as
disconnected and the DJ connects again.

Imported rows are read back from the service at launch, pre-listen serves the
provider's clip through the same `/api/tracks/:id/preview` route uploads use,
and every row carries the uploader's name and a link back to the track — that
last one is a condition of the API terms.

**Spotify is deliberately not supported.** The quota ceiling and the Developer
Policy are why, not the technology.

Full reasoning, the alternatives weighed, and what is deferred:
[docs/0001-connected-music-accounts.md](docs/0001-connected-music-accounts.md).

## Play

`/play` is the listening side of the catalogue. Open one uploaded catalogue on
its own from the sidebar or search every one of them at once, listen to songs
inline, and collect them into playlists. The song currently
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

Songs play in full here, so a playlist is a listenable set rather than an
audition, and the dock counts against the whole song. The thirty-second window
is the crowd's: in the booth a row is a taste of something they are voting on,
which is a different job from a DJ listening to their own catalogue.

## Now Playing

The live booth has a **Now playing** panel with one main action: *Play crowd
pick*, which puts on the top-voted song that is not on cooldown. Every row in
the queue also has its own *Play*, for the DJ's call rather than the crowd's:
a request from the floor, a change of mood, a song that is still cooling
(cooldown limits votes, not the DJ; on a cooling row the button reads
*Replay*, so it is a choice, not a slip). The row on now says *On now* there
instead, and a row with no audio says so (phones stay silent on it). A row's
Play names the song it saw playing, so a tap that lands after another booth
tab, or auto-advance, has already moved the room does nothing and says so;
tapping the song that is already on is a no-op. The DJ can also take a song
off. Each change stamps the track as played and bumps the room revision, so
every guest's next poll carries it. The headphones on a row's art are the
DJ's private pre-listen, not the room's speakers.

A played song is not gone for good — people may want to hear it again — but it
sits out on a **cooldown** until two other songs have rolled (fewer in a room
with fewer songs: a two-track room cools for one, a one-track room never
does). While cooling it sinks below the ballot, its row says how many songs
are left, and a vote on it is refused with *"Cooldown — try again after
two/one more song(s) have rolled."* (409, code `COOLDOWN`). Its votes are
spent when it plays: the rows are kept, so the room's totals do not shrink,
but only votes cast after that play count or show as someone's pick, and the
same people — an anonymous guest re-tapping their free vote included — can
vote it back up once it is open. So a song comes back on fresh votes, never on
the ones that already got it played.

The crowd pick is the open song with the most live votes; on a tie a song that
has never played goes before one that has, then the one that played longest
ago, then the DJ's order — so every song gets its turn before any repeats, and
the room never runs dry. Guests see the same order on the ballot.

If the DJ does nothing when a song ends, the booth puts the crowd pick on by
itself. The server never decodes audio, so the booth reads the song's length
from the file's metadata and, every few seconds, checks whether
`startedAt + duration` (plus a short grace) has passed — a repeating check
rather than one timer, so an advance that failed on bad wifi is retried, a
song whose length could not be read is re-probed, and a browser throttling a
background tab cannot stall it. `startedAt` is server time, so the booth
corrects for its own clock using the server's `Date` header from each poll.
The request names the song it is meant to follow and the server ignores it if
that song is no longer on, so a second booth tab or a request that was slow
while the DJ tapped cannot skip a song. It works in whichever view the host
has open; what it needs is the booth tab itself, since guest phones only
follow what is playing, they never drive it.

Guests have no per-song play button; the only audio on a guest's phone is the
song on air, docked under the ballot with a *Listen along* button.
Browsers refuse unprompted audio, so the first song needs a tap; after that a
change of song follows automatically. A late joiner starts partway through,
offset by how long the DJ has had the song on, so a phone roughly tracks the
room rather than restarting from the top. This is phone playback of the same
file, not a synced broadcast — expect drift of a second or two. A joiner who
arrives after the song has run out is told it has finished rather than hearing
it restart, and the dock stays unlocked while the DJ has nothing on, so the
next song still follows without another tap. The server refuses a new vote on
a played track (409), since a guest's ballot can be up to one poll behind.

## Who Voted

Each row shows the faces behind its live votes: an initial in a colour derived
from the pseudonym for every account vote, a blank bubble for every anonymous
free vote, a `+N` for the rest, and a sentence — *"Amyr, Nathan and 171
others"*. The server sends up to twenty voters per track, named ones first
(anonymous ones are all the same bubble, so a run of them would say nothing),
and the phone shows as many faces as fit its width — measured, not guessed —
folding the rest into the `+N`. Nothing that identifies a voter beyond the
pseudonym they chose to show is sent:
no account IDs, and never the anonymous voter ID, which is what entitles a
browser to its free vote. Votes spent by a play take their faces with them.

The booth's **Crowd queue** header and the guest page's **Make your picks**
header carry the room-wide stack: one face per
person who has voted in the room, whichever songs they picked, named first
and newest first, up to twenty, with `+N` and the sentence making up the
`guestCount`. Unlike a row's faces these do not clear when a song plays —
the person is still in the room.

## Voting Identity

QR guests receive a browser voter ID in local storage and can cast one free
vote per room without onboarding. A second pick asks for a private phone number
and a pseudonym. A new number creates the account; a number that already has
one logs into it, with its own pseudonym kept — login is phone-only and
unverified either way, so the sign-up form and the login form clear the same
bar and a known number is never sent back to "log in instead". The browser's
free vote carries over to the account unless the browser is already linked to
another account (a phone passed around a table), in which case there is
nothing to carry and the login still goes through. Clearing browser storage
can create a new voter ID, so this is a best-effort device limit until phone
verification is added.

The account routes are rate limited per client address, and one venue is one
address: every phone on the wifi shares the NAT, and so does every phone that
reaches the dev server through the tunnel. The window is therefore sized for
a room's first quarter hour, and a login that succeeds gives its slot back:
enumerating numbers is paid for in misses, and a crowd's real logins are not
misses.

## Tips For A Pick

A DJ can add a Cash App cashtag, a Venmo username, or both while opening a
room. Those handles belong to that room rather than to the account, are fixed
once it goes live, and are remembered only in the DJ's browser to prefill the
next setup. The server accepts handles rather than arbitrary URLs and builds
the providers' public HTTPS links itself.

After a guest's vote is saved, that row offers **Tip for this pick**. It
opens a sheet with the song and a copyable room reference, then hands the guest
to Cash App or Venmo in a new tab. UP/NEXT does not verify who owns the
DJ-provided profiles, so the sheet tells guests to confirm the recipient before
sending. It also does not receive payment status, store amounts, take a fee, or
claim that a tip was completed. A tip never changes votes, queue order,
cooldown, or auto-advance, and the sheet says plainly that it does not guarantee
a play.

Cash App and Venmo are US services, and DJs are responsible for using profiles
eligible to receive their payments. A future guaranteed-request product would
need an actual marketplace integration, verified accounts, webhooks, durable
financial records, captures and refunds; external profile links deliberately
do none of that.

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

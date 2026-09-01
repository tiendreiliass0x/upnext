# 0001 — Connected music accounts

**Status:** Accepted
**Date:** 2026-08-31
**Landed in:** `caf71d5`

## The problem

A room's ballot could be built from three things: a filename dragged into the
booth, a line in an `.m3u`, or a row an admin had curated into a shared library.
Title and artist came from `trackFromName()` (`src/components/Dashboard.tsx`),
which strips the extension and splits on a hyphen. There was no artwork, no
canonical ID, and nothing to link back to.

The practical consequence: a DJ who had already curated a set somewhere had to
re-upload all of it to play it here.

The ask was to link **Spotify and SoundCloud** and pick from either.

## Decision

A DJ connects their own SoundCloud account by OAuth from setup step 02, browses
their playlists and liked tracks, and picks rows straight into the ballot.
Imported rows carry real metadata, artwork, and a required credit.

**Spotify is not supported and should not be built.** See below.

## Constraints

These were discovered during design and are what actually shaped the result.

**Spotify:**

- `preview_url` is null for any app registered since the
  [November 2024 deprecation](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api);
  [Get Track](https://developer.spotify.com/documentation/web-api/reference/get-track)
  now marks the field Deprecated and Nullable.
- [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes):
  development mode is capped at **five allowlisted users** and requires the app
  owner to hold Premium. Extended quota has, since May 2025, been open to
  **organisations only, with a 250,000 MAU floor**.
- The [Developer Policy](https://developer.spotify.com/policy) names this app's
  category outright, prohibiting *"software for restaurants, shops, bars, or
  other retail locations"* and using the catalog *"to segue, mix, re-mix, or
  overlap any Spotify Content"*. The
  [Widget Terms](https://developer.spotify.com/documentation/embeds/terms) add
  that the play button *"may not be used for commercial purposes."*

**SoundCloud:**

- [Registration](https://developers.soundcloud.com/docs/api/register-app) is
  self-serve and immediate, but requires an active **Artist Pro** subscription.
- PKCE is required. Auth header is `Authorization: OAuth <token>`, **not**
  `Bearer` — sending Bearer returns a 401 indistinguishable from an expired
  token, which would send the refresh path into a loop.
- **Refresh tokens are single-use and rotate on every refresh.**
- Client-credentials tokens are capped at **50 requests per 12 hours per app**,
  so they are useless here; everything goes through the DJ's own token.
- Progressive HTTP streams were
  [retired at the end of 2025](https://developers.soundcloud.com/blog/api-streaming-urls/).
  `/tracks/{urn}/streams` now returns `hls_aac_160_url`, `hls_mp3_128_url` and
  `preview_mp3_128_url`.
- The [API Terms](https://developers.soundcloud.com/docs/api/terms-of-use)
  require the uploader credited, SoundCloud credited, and a **visible backlink**
  to the track wherever it is shown; and prohibit caching or persisting the
  audio.
- Stream access is capped at **15,000 per 24 hours** per client ID.

**Ours:** a guest in the room is anonymous and has no music-service account, so
crowd pre-listen cannot depend on a token.

## What was considered

### Spotify for metadata only, without preview audio

The app already renders rows with no audio ("no audio", vote-only), so Spotify
could have supplied titles and artwork while the crowd simply could not
pre-listen. Rejected on the quota ceiling and the policy, not the audio: five
DJs, permanently, is not a feature, and the policy prohibition is categorical
rather than something a preview-only design routes around.

### Provider embeds for playback (Spotify IFrame API, SoundCloud Widget)

Both are official, both play for a logged-out viewer, and both expose a JS API
for play/pause and events — which would have solved anonymous crowd playback
without any token at play time. This was the leading design until the Widget
Terms turned up the "no commercial purposes" clause on the Spotify side, and
until SoundCloud turned out to still ship a real preview MP3, which needs no
iframe, no third-party script on the guest page, and no second playback path to
arbitrate against the existing `<audio>`.

### `hls_aac_160_url` for full-track playback

The quality option, and it would let a guest's phone play along with the whole
room. Rejected for now: HLS does not play in a bare `<audio>` outside Safari, so
it needs hls.js in a project whose runtime dependencies are deliberately tiny;
the URLs require an authenticated request that returns a 302 to hand on; and
every play counts against the 15,000/day ceiling.

### `preview_mp3_128_url` — chosen

Progressive MP3, plays natively everywhere, and runs about the length this app
already offers (`previewSeconds = 30`, `src/lib/preview.ts`).

The decisive property is that it needs no new client code at all.
`GET /api/tracks/:id/preview` already answers with a URL that the client sets on
an `<audio>` element; for an imported row it resolves the provider's clip
instead of presigning R2. The pre-listen button, the guest now-playing dock, the
`/play` console and the `exclusiveAudio` one-song-at-a-time rule were all
untouched.

### Where connecting lives

`/play` was the first choice — it is already the music console and holds no
fragile state, so an OAuth redirect costs nothing. The booth's setup screen is
where a DJ actually adds music, but its draft list holds `File` objects for
songs already dragged in, and a `File` cannot survive a round trip through
another origin.

Resolved by putting the picker where the work happens and **opening the provider
in a popup** instead of navigating, so the booth page never unmounts. The popup
is opened synchronously on the click, before any `await`, because one opened
after an await has lost the user gesture and gets blocked; it is then pointed at
the authorize URL once the server has minted one.

### Where imported rows are stored

`playlist_tracks.library_track_id` is `NOT NULL` and part of the primary key, so
letting an UP/NEXT playlist point at an external track means rebuilding the
table — the one thing this schema has never done (every migration to date is an
additive `ALTER TABLE ADD COLUMN` guarded by `PRAGMA table_info`).

Avoided entirely by importing straight into a room's ballot: `tracks` takes six
new nullable columns and nothing else changes. A separate `external_tracks`
table was drafted and dropped as unnecessary once the playlist path was out of
scope.

## How the pieces defend themselves

**Import is server-authoritative.** The booth sends only
`{ provider, providerTrackId }`. Title, artwork, uploader and permalink are
re-read from the service before `createSession` runs. This is a security
requirement: all of it renders into an anonymous guest's page, so a room author
must not get to choose where a guest's browser is sent — a forged permalink
would be a phishing link sitting under a credit the terms require us to display.
The lookup happens outside the transaction, because better-sqlite3 is
synchronous and would otherwise hold its write lock for a network round trip.

**Tokens are sealed.** A provider refresh token is a standing grant against
someone else's account — unlike every other secret here, which this app issued
and can revoke by deleting a row — and `data/dj-booth.sqlite` is a plain file.
They are encrypted with AES-256-GCM under `TOKEN_ENCRYPTION_KEY`
(`src/lib/secrets.ts`). GCM rather than an unauthenticated mode so a tampered
row fails to open instead of decrypting to garbage that then gets sent to a
provider. An unreadable row reads as *not connected*, so a rotated key costs a
reconnect rather than a crash.

**Refresh is serialised, and failure is classified.** Because the refresh token
is single-use, two concurrent requests would spend the same token, the loser
would store one the provider has already retired, and the DJ would be signed out
mid-set. A `refreshing_until` claim lets exactly one holder refresh; the claim
ages out so a crashed request cannot wedge it, and is handed back immediately on
failure. Waiters get a budget long enough to outlast a slow provider — giving up
early would turn one slow round trip into a false "reconnect your account" for
every other request in the room.

Only the provider actually refusing the grant deletes a credential. A timeout, a
429 or a 5xx is the provider having a bad moment, and the credential is still
good; deleting it would cost the DJ the whole OAuth dance for a blip.

Reconnecting keeps the existing row — the upsert conflicts on
`account_id + provider` — so a refresh that started before a reconnect and
finished after it addresses the same id, and would otherwise overwrite brand new
tokens with older ones, or delete the account on its way out. Both writes are
therefore compare-and-swap against the sealed `access_token` they read. Sealing
uses a fresh nonce every time, so the stored ciphertext is unique to one write
and makes a natural CAS token without another column.

**Preview URLs are cached behind the gate, never in front of it.** The preview
route is deliberately unauthenticated — being a track in a live room is the whole
gate — so every phone in the room can ask for the same song at once. Resolved
URLs are held in memory for ten minutes keyed by track, so a 200-person room
costs one provider call per song rather than 200. Only the URL is cached;
caching the audio is forbidden by the terms.

The order matters and is easy to get backwards. The room check and the DJ's
grant are both verified **before** the cache is consulted, because a cached URL
served in front of them would keep handing out the provider's audio for the life
of the entry — ten minutes past the end of the room, or ten minutes after the DJ
disconnected the account. The cache exists to save a provider round trip, not a
local SQLite read.

**A row only claims audio if it is fully identified.** An imported row is
playable only with a provider, a track ID *and* a permalink. If the lookup at
launch comes back empty — a 404, an outage, an account disconnected between
picking and launching — the row keeps the title the picker showed and loses the
provider claim entirely, becoming an ordinary vote-only row. Keeping the handle
while missing the permalink would give the crowd a control that 404s, and would
start serving the provider's audio with no credit attached the moment they
recovered.

**Imports are bounded and idempotent.** Track lookups run a few at a time rather
than all at once: 200 simultaneous requests from one click reads as an attack and
burns the daily ceiling the whole deployment shares. And whether this request is
a retry is settled *before* any network call, because the provider's answer can
differ between tries — otherwise a retry after a lost response could be told
"none of those songs can be played" about a room that is already open.

**Attribution ships with the row.** The uploader's name and a visible link to
the track render in `QueueList` and on the now-playing card. It is a condition
of the terms, not styling, so it has a test rather than a CSS rule.

**The clip is not the song, and the booth has to know it.** Auto-advance learns
a song's length by probing what it is about to play, which is right for an
upload — the file is the song. For an imported row the thing it plays is a
~30-second clip, so probing it would advance the room after the snippet while
the DJ was a minute into a four-minute track. The provider's stated duration is
carried through `NowPlaying` and is authoritative; the probe is now only for
uploads, where the file is the sole source of the length.

This is the general shape of the hazard in this design: pre-listen and playback
share one URL on purpose, and anywhere the app treats that URL as *the song*
rather than *a taste of it* is a bug waiting to happen.

## Trade-offs

- Guests hear a preview-length clip of an imported row, not the whole song. The
  room still hears the DJ's own gear, which is the model the app is built on.
- Every provider call spends one DJ's quota and the app's shared allowance, so
  the proxy routes are rate-limited per account and per address.
- A DJ needs an Artist Pro subscription before any of this does anything. That
  is a real barrier and it is on the provider, not us.
- One provider means the `MusicProvider` interface has exactly one
  implementation. It exists so the routes and the picker never name a service,
  not as speculative generality.

## Deferred

- **Full-track playback** via HLS. See the rejected option above; the blocker is
  a dependency and a quota, both of which could be reconsidered.
- **Saving imported tracks into an UP/NEXT playlist**, blocked on the
  `playlist_tracks` rebuild described above.
- **Crowd requests from a connected source.** Explicitly "later" at design time;
  the adapter and route shapes were built to take it.
- **Searching the wider catalogue** rather than the DJ's own playlists — one
  more adapter method, no new plumbing.

## Open questions

- **Does the tipping layer clear SoundCloud's terms?** They prohibit
  *"advertising, sponsorship or promotion around User Content."* Tipping the DJ
  is not obviously that, but it is close enough to the line to be worth their
  *"case by case basis"* approval before this runs in a real venue. Unresolved;
  needs SoundCloud, not us.
- **Does Spotify's position ever change?** Only a quota-policy change would
  reopen it, and the policy prohibition on venue software would still stand.
  Revisit only on evidence, not on hope.

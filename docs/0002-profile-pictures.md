# 0002 — Profile pictures and the name beside a vote

**Status:** Accepted
**Date:** 2026-09-02
**Landed in:** _(pending — see the profile branch)_

## The problem

An account was a phone number and a pseudonym, and the pseudonym was writable
only through the sign-up form. Two things followed from that.

A DJ who mistyped their name at sign-up could only fix it by re-submitting the
sign-up form with the same number, which the accounts route treats as a login
that deliberately *discards* the pseudonym typed into it — knowing a number must
not rename its owner. So in practice the name was permanent.

And the room had no faces in it. Voting is the social act in a venue and the
ballot already showed who was in on a song, but only as a coloured bubble with
one letter in it. The letter is a stand-in for a picture, and there was no way
to supply the picture.

## Decision

Accounts gain `avatar_key` and `tagline`. A new `PATCH /api/accounts` edits the
text fields against a bearer token, and `POST`/`DELETE /api/accounts/avatar`
sets and clears the picture. The picture is stored in R2 as uploaded and read
back through `GET /api/avatars/<name>`, which redirects to a presigned URL.

The object key is `avatars/<uuid>.<ext>` — **no account ID in the path** — and
the URL that appears in a room's payload is that name and nothing else. A new
picture gets a new name, so the URL changes when the picture does. The read
route checks the key is still some account's current picture before it signs
anything, so a well-formed name is not on its own enough to fetch one.

Editing a profile bumps the revision of every live room the account hosts or
has voted in, reusing the mechanism a rename already had: guests poll with a
revision-keyed ETag, and without the bump they keep hearing 304. Only fields
that actually changed are written, so an edit that changes nothing costs the
room nothing, and two edits of different fields cannot undo one another. The
room's representation version moved to 3 for the same reason the mechanism
exists: a tag issued before this shipped must not answer 304 for a payload
that now carries faces.

## Constraints

- **The room payload is public.** `getSession` is served to anonymous guests
  and the existing code goes out of its way to leak nothing that identifies a
  voter beyond the pseudonym they chose (see the comment above
  `getTrackVoters` in [`src/lib/sessions.ts`](../src/lib/sessions.ts)). Whatever
  addresses a picture ends up next to every face in the venue.
- **R2 objects are private.** Every read is a presigned URL, as it is for audio
  ([`src/lib/r2.ts`](../src/lib/r2.ts)); there is no public bucket to link to.
- **There is no image library on the server.** Adding `sharp` to a build that
  already ships a 885 MB `node_modules` onto a small VPS is a real cost, and
  `output: "standalone"` exists precisely to keep that down.
- **The booth is a client component.** Anything the form and a route both need
  has to be reachable from the browser bundle, which is why the validators and
  the key helpers live in [`src/lib/profile.ts`](../src/lib/profile.ts) rather
  than in `accounts.ts` — importing a value from `accounts.ts` drags
  `better-sqlite3` into the client and breaks the build.

## What was considered

### `/api/accounts/<id>/avatar`

The obvious REST shape, and the first thing written. Rejected because it puts
an account ID beside every face in the room. An ID is not a capability here —
nothing accepts one as authentication — but it is a *stable identifier for a
person*, and handing every guest in a venue one for everybody else undoes the
care the voter queries already take. The random object name carries no such
thing, and it has a second property the ID does not: it changes with the
picture, which is what makes the URL safe to cache hard.

### Signing any well-formed key, with no database lookup

The first version of the read route did this: the key shape alone decided, so
the route touched no account state at all. It was rejected once the failure
mode was traced. Removing a picture forgets the row and *then* deletes the
object, and that delete is best effort — it can fail, and by then nothing
records that the object should be gone. A route that signed on shape alone
would keep serving a removed picture to anyone holding its URL for as long as
the failed delete went unnoticed, which is indefinitely. The lookup is one
hit on a partial index and the answer is cached by the redirect, so the cost
is small and the guarantee is worth having.

### Streaming the bytes through the app instead of redirecting

Full control of caching, no signed URL a guest can pass on. Rejected because
every face in every room would then be bytes through the VPS, and the app
already redirects for audio, where the argument is far stronger. The redirect
is cached for less than the signing window, so the browser re-asks well before
a signature expires.

### Trusting the byte ceiling to bound what a picture costs

Bytes bound storage and transfer. They do not bound decoding: a solid
10000×10000 PNG compresses to a few hundred kilobytes and asks every guest's
phone for roughly 400 MB of RGBA to draw one 30-pixel face. So the header is
parsed for the declared pixel size and that is bounded too, and a file whose
dimensions cannot be read is refused rather than trusted. The limits sit where
a current phone camera's long side still fits, because they are the backstop —
the form shrinks a picture to 512 pixels before sending it, so anything that
arrives at the limits came some other way.

### Resizing or re-encoding on upload

What a picture shown at 30 pixels across obviously wants. Rejected for now on
the dependency cost above. The 2 MB ceiling stands in for it: it is the only
thing between a phone camera's original and the bucket, so it is enforced three
times over. The form refuses an oversized file before sending it, so a phone on
venue wifi is not told "too big" after a minute of uploading. The route refuses
a declared `Content-Length` over the ceiling — and refuses a request that
declares none at all with a `411`, because the body is buffered whole and a
chunked request would otherwise arrive bounded by nothing but Caddy's 65 MB cap.
And the file's own size is checked once it is parsed, in case the declaration
was a lie. The audio route treats a declared size as the same kind of
precondition, for the same reason.

### Moving the tip handles into the profile

They are typed per room and already persist in this browser's local storage.
Making the profile a second home for them would give the same handle two
sources of truth, and a room's handles are deliberately fixed once it goes
live. Left alone.

### Making the phone number editable

It is the login credential, and login is unverified on purpose (see
[`admin.ts`](../src/lib/admin.ts) and 0001). A profile form that can rewrite
the credential is a different security question from one that can rewrite a
display name, and it is not one this change needed to answer. The sheet shows
the last four digits and says why they are read-only.

## Trade-offs

- **SVG is refused.** It is a document that can carry script and the bytes come
  back under a URL of ours, so an SVG avatar would be stored cross-site
  scripting rather than a picture. Format is decided by sniffing leading bytes,
  like audio, not by the name or the `Content-Type` the browser claimed.
- **A picture URL is a bearer capability for that picture.** Anyone handed one
  can fetch it for as long as the signature lasts. That is the same bargain
  audio already makes, and a profile picture is shown to the whole room anyway.
- **Avatars are outside the storage quota and outside cleanup.** One account
  holds at most one, and replacing or removing it deletes the object it
  replaces, so there is normally nothing for the reaper to find. A crash
  between the R2 delete and the row update would leave a broken picture; the
  order is chosen so the failure that can happen is a wasted byte instead. The
  key being replaced is read inside the write rather than from the snapshot
  the request arrived with, so two uploads racing cannot both claim the same
  predecessor and strand one of their objects.
- **A rename now touches more rows.** Editing a tagline bumps the same rooms a
  rename does. That is the point — a stale picture is as wrong as a stale name —
  but it means an idle profile edit still invalidates every guest's ETag.

## Deferred

- **Server-side downscaling.** The form downscales through a canvas, which
  covers every browser that matters but is an optimisation, not a guarantee:
  a client that cannot or will not shrink its upload is bounded only by the
  route's dimension limits, which are generous. Worth revisiting if avatars
  dominate storage, or if a WebAssembly encoder makes the dependency cheap.
  The upload route is the single place it would go.
- **Pictures for anonymous voters.** They are one blank bubble by design: five
  distinguishable anonymous faces would tell the room nothing it can act on.
- **A profile page rather than a sheet.** The sheet reuses the tip sheet's
  shell — same portal, same focus trap. A standalone route is worth it only
  once there is more on it than three fields.

## Open questions

Whether the tagline should appear anywhere besides the guest room heading —
the booth's own header and the tip sheet both name the DJ and could carry it.
Left off until someone asks for it, on the grounds that the room is where a
stranger meets the DJ and the other two are places they already know who is
playing.

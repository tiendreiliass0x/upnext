import { NextResponse } from "next/server";
import { getAccountFromRequest } from "@/lib/auth";
import { getPublicBaseUrl, maximumDraftTracks } from "@/lib/config";
import { getAccessToken, guardProviderRequest } from "@/lib/connections";
import { getProvider, isProviderId } from "@/lib/providers";
import type { ProviderId, ProviderTrack } from "@/lib/providers/types";
import {
  createSession,
  getActiveHostSession,
  hasSessionForRequest,
} from "@/lib/sessions";
import { InvalidTipHandleError, normalizeTipHandles } from "@/lib/tips";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestedTrack = {
  title: string;
  artist: string;
  previewKey: string | null;
  provider: ProviderId | null;
  providerTrackId: string | null;
};

/**
 * Re-read every imported row from the service it came from.
 *
 * The client sends nothing but a provider and a track ID. Everything else --
 * the artwork a guest's browser loads, the link behind the uploader credit --
 * is read from the provider here, because all of it is rendered into an
 * anonymous guest's page and a room author must not get to choose where those
 * point. A forged permalink would be a phishing link sitting under a credit
 * the terms require us to show.
 *
 * This runs before createSession so no network call happens inside the
 * better-sqlite3 transaction, which is synchronous and would hold its write
 * lock for the length of the round trip.
 */
async function resolveImportedTracks(
  accountId: string,
  requested: RequestedTrack[],
) {
  const wanted = new Map<ProviderId, string[]>();
  for (const track of requested) {
    if (!track.provider || !track.providerTrackId) continue;
    const ids = wanted.get(track.provider) ?? [];
    ids.push(track.providerTrackId);
    wanted.set(track.provider, ids);
  }

  const resolved = new Map<string, ProviderTrack>();
  for (const [providerId, ids] of wanted) {
    const provider = getProvider(providerId);
    if (!provider) continue;
    try {
      const accessToken = await getAccessToken(accountId, provider);
      for (const track of await provider.getTracks(accessToken, ids)) {
        resolved.set(`${providerId}:${track.providerTrackId}`, track);
      }
    } catch {
      // A service that will not answer must not stop the DJ opening a room.
      // The rows fall back to what the picker showed them, minus the parts
      // only the provider can vouch for.
    }
  }
  return resolved;
}

export async function GET(request: Request) {
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  return NextResponse.json({
    activeRoom: getActiveHostSession(account.id),
    guestBaseUrl: getPublicBaseUrl(),
  });
}

export async function POST(request: Request) {
  try {
    const account = getAccountFromRequest(request);
    if (!account) {
      return NextResponse.json(
        { error: "Sign in before opening a room." },
        { status: 401 },
      );
    }

    const body = (await request.json()) as {
      name?: unknown;
      venue?: unknown;
      tracks?: unknown;
      requestId?: unknown;
      cashAppHandle?: unknown;
      venmoHandle?: unknown;
      keepOpen?: unknown;
    };

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const venue = typeof body.venue === "string" ? body.venue.trim() : "";
    const requestId =
      typeof body.requestId === "string"
        ? body.requestId.trim().slice(0, 100) || null
        : null;
    const rawTracks = Array.isArray(body.tracks) ? body.tracks : [];
    const requested: RequestedTrack[] = rawTracks
      .filter(
        (track): track is {
          title: string;
          artist: string;
          previewKey?: string | null;
          provider?: unknown;
          providerTrackId?: unknown;
        } =>
          typeof track === "object" &&
          track !== null &&
          typeof (track as { title?: unknown }).title === "string" &&
          typeof (track as { artist?: unknown }).artist === "string",
      )
      .slice(0, maximumDraftTracks)
      .map((track) => ({
        title: track.title.trim().slice(0, 120),
        artist: track.artist.trim().slice(0, 120) || "Unknown artist",
        previewKey:
          typeof track.previewKey === "string"
            ? track.previewKey.slice(0, 500)
            : null,
        provider: isProviderId(track.provider) ? track.provider : null,
        providerTrackId:
          typeof track.providerTrackId === "string"
            ? track.providerTrackId.slice(0, 200)
            : null,
      }))
      .filter((track) => track.title.length > 0);

    if (!name || requested.length === 0) {
      return NextResponse.json(
        { error: "Add a session name and at least one track." },
        { status: 400 },
      );
    }

    // Settled before any network call. createSession owns idempotency, but it
    // is reached at the far end of a provider round trip whose answer can
    // differ between tries -- so a retry after a lost response could be told
    // "none of those songs can be played" about a room that is already open.
    const isRetry = requestId ? hasSessionForRequest(account.id, requestId) : false;

    const limited = isRetry ? null : guardProviderRequest(request, account.id);
    if (limited) return limited;

    const imported = isRetry
      ? new Map<string, ProviderTrack>()
      : await resolveImportedTracks(account.id, requested);
    let skipped = 0;
    const tracks = requested.flatMap((track) => {
      if (!track.provider || !track.providerTrackId) return [track];

      const found = imported.get(`${track.provider}:${track.providerTrackId}`);
      // A track the service will not let anyone play is not a ballot row: the
      // crowd would be voting for silence. The count goes back to the booth so
      // the DJ is told rather than quietly handed a shorter set.
      if (found?.access === "blocked") {
        skipped += 1;
        return [];
      }
      // Nothing came back -- a 404, an outage, an account disconnected between
      // picking and launching. Keep the row on the strength of what the picker
      // showed the DJ, but drop the provider claim with it: a row that keeps
      // the handle and loses the permalink would advertise audio the preview
      // route cannot serve, and would start serving it with no credit attached
      // if the provider came back. Vote-only is the honest state.
      if (!found) {
        return [
          {
            title: track.title,
            artist: track.artist,
            previewKey: track.previewKey,
            provider: null,
            providerTrackId: null,
          },
        ];
      }
      return [
        {
          ...track,
          title: found.title,
          artist: found.artist,
          artworkUrl: found.artworkUrl,
          permalinkUrl: found.permalinkUrl,
          uploaderName: found.uploaderName,
          durationMs: found.durationMs,
        },
      ];
    });

    if (tracks.length === 0) {
      return NextResponse.json(
        { error: "None of those songs can be played here." },
        { status: 400 },
      );
    }

    let tipHandles;
    try {
      tipHandles = normalizeTipHandles({
        cashApp: body.cashAppHandle,
        venmo: body.venmoHandle,
      });
    } catch (error) {
      if (error instanceof InvalidTipHandleError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    const result = createSession({
      name: name.slice(0, 80),
      venue: venue.slice(0, 80),
      accountId: account.id,
      requestId,
      keepOpen: body.keepOpen === true,
      tipHandles,
      tracks,
    });

    return NextResponse.json(
      { ...result, guestBaseUrl: getPublicBaseUrl(), skippedTracks: skipped },
      { status: 201 },
    );
  } catch {
    return NextResponse.json(
      { error: "The session could not be created." },
      { status: 500 },
    );
  }
}

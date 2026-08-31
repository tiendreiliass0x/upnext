import { fetchWithTimeout, readJson } from "@/lib/http-client";
import {
  ProviderRequestError,
  type MusicProvider,
  type ProviderAccount,
  type ProviderPlaylist,
  type ProviderTokens,
  type ProviderTrack,
  type ProviderTrackAccess,
} from "@/lib/providers/types";

const authorizeEndpoint = "https://secure.soundcloud.com/authorize";
const tokenEndpoint = "https://secure.soundcloud.com/oauth/token";
const apiBase = "https://api.soundcloud.com";

/** Reading the DJ's own playlists and likes; nothing is ever written back. */
const scope = "non-expiring";

/** The synthetic playlist for "tracks I liked", which has no real ID. */
export const likesPlaylistId = "likes";

const maximumTracks = 200;
// How many track lookups may be in flight at once during an import.
const lookupConcurrency = 6;

function credentials() {
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID?.trim();
  const clientSecret = process.env.SOUNDCLOUD_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * SoundCloud wants `Authorization: OAuth <token>`, not `Bearer`. Sending
 * Bearer gets a 401 that reads exactly like an expired token, which would
 * send the refresh path into a loop, so it is worth its own function.
 */
function authHeaders(accessToken: string) {
  return { Authorization: `OAuth ${accessToken}`, Accept: "application/json" };
}

async function postForm(body: Record<string, string>) {
  const response = await fetchWithTimeout(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });
  const data = await readJson<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  }>(response);

  if (!response.ok || !data.access_token) {
    throw new ProviderRequestError(
      response.status,
      data.error || "SoundCloud rejected the sign-in.",
    );
  }
  return {
    accessToken: data.access_token,
    // Refresh tokens rotate here: a response that carries one is replacing
    // the token that was just spent, and it has to be stored.
    refreshToken: data.refresh_token ?? null,
    expiresInSeconds:
      typeof data.expires_in === "number" ? data.expires_in : null,
    scopes: data.scope ?? scope,
  } satisfies ProviderTokens;
}

async function get<T>(accessToken: string, path: string) {
  const response = await fetchWithTimeout(`${apiBase}${path}`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) {
    throw new ProviderRequestError(
      response.status,
      response.status === 401
        ? "SoundCloud rejected the saved sign-in."
        : "SoundCloud could not be reached.",
    );
  }
  return readJson<T>(response);
}

type RawUser = { username?: string; permalink_url?: string };
type RawTrack = {
  id?: number;
  urn?: string;
  title?: string;
  duration?: number;
  permalink_url?: string;
  artwork_url?: string | null;
  access?: string;
  streamable?: boolean;
  user?: RawUser;
};
type RawPlaylist = {
  id?: number;
  urn?: string;
  title?: string;
  track_count?: number;
  artwork_url?: string | null;
  tracks?: RawTrack[];
};

/** Endpoints answer either a bare array or a linked-partitioning wrapper. */
function collectionOf<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const collection = (payload as { collection?: unknown }).collection;
    if (Array.isArray(collection)) return collection as T[];
  }
  return [];
}

/**
 * Artwork comes back at 100x100, which is visibly soft on the queue rows.
 * The size is a segment of the filename, so asking for a bigger one is a
 * string swap; anything unexpected is left exactly as it arrived.
 */
function upsizeArtwork(url: string | null | undefined) {
  if (!url) return null;
  return url.replace("-large.", "-t500x500.");
}

function trackUrn(raw: RawTrack) {
  if (raw.urn) return raw.urn;
  return typeof raw.id === "number" ? `soundcloud:tracks:${raw.id}` : "";
}

function readAccess(raw: RawTrack): ProviderTrackAccess {
  if (raw.access === "playable" || raw.access === "preview") return raw.access;
  if (raw.access === "blocked") return "blocked";
  // Older payloads carry `streamable` instead. Absent both, assume the worst
  // so a row never claims audio the guest's phone cannot get.
  if (raw.streamable === true) return "playable";
  return "blocked";
}

function toTrack(raw: RawTrack): ProviderTrack | null {
  const providerTrackId = trackUrn(raw);
  const title = raw.title?.trim();
  // A playlist can hold entries the API will not describe (removed, private
  // to someone else). They arrive as near-empty objects; drop them.
  if (!providerTrackId || !title || !raw.permalink_url) return null;

  return {
    providerTrackId,
    title,
    artist: raw.user?.username?.trim() || "Unknown artist",
    artworkUrl: upsizeArtwork(raw.artwork_url),
    durationMs: typeof raw.duration === "number" ? raw.duration : null,
    permalinkUrl: raw.permalink_url,
    uploaderName: raw.user?.username?.trim() || "Unknown artist",
    access: readAccess(raw),
  };
}

function matches(track: ProviderTrack, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    track.title.toLowerCase().includes(needle) ||
    track.artist.toLowerCase().includes(needle)
  );
}

export const soundcloud: MusicProvider = {
  id: "soundcloud",
  label: "SoundCloud",
  allowedHosts: ["soundcloud.com", "i1.sndcdn.com", "a1.sndcdn.com"],

  isConfigured() {
    return credentials() !== null;
  },

  authorizeUrl({ redirectUri, state, codeChallenge }) {
    const config = credentials();
    if (!config) throw new Error("SoundCloud is not configured.");
    const url = new URL(authorizeEndpoint);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("scope", scope);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  },

  async exchangeCode({ code, codeVerifier, redirectUri }) {
    const config = credentials();
    if (!config) throw new Error("SoundCloud is not configured.");
    return postForm({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      code,
    });
  },

  async refresh(refreshToken) {
    const config = credentials();
    if (!config) throw new Error("SoundCloud is not configured.");
    return postForm({
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    });
  },

  async me(accessToken) {
    const raw = await get<{
      id?: number;
      urn?: string;
      username?: string;
      permalink_url?: string;
    }>(accessToken, "/me");
    return {
      id: raw.urn || (typeof raw.id === "number" ? String(raw.id) : ""),
      displayName: raw.username?.trim() || "SoundCloud account",
      permalinkUrl: raw.permalink_url ?? "",
    } satisfies ProviderAccount;
  },

  async listPlaylists(accessToken) {
    const payload = await get<unknown>(
      accessToken,
      "/me/playlists?limit=100&linked_partitioning=1&show_tracks=false",
    );
    const playlists = collectionOf<RawPlaylist>(payload)
      .filter((raw) => typeof raw.id === "number" || Boolean(raw.urn))
      .map((raw) => ({
        id: String(raw.id ?? raw.urn),
        title: raw.title?.trim() || "Untitled playlist",
        trackCount: typeof raw.track_count === "number" ? raw.track_count : null,
        artworkUrl: upsizeArtwork(raw.artwork_url),
      }));

    // Likes are where a lot of DJs actually keep the set they would play, and
    // the API exposes them separately from playlists. Surfaced as one more
    // row so the picker has a single list to render.
    return [
      { id: likesPlaylistId, title: "Liked tracks", trackCount: null, artworkUrl: null },
      ...playlists,
    ] satisfies ProviderPlaylist[];
  },

  async listPlaylistTracks(accessToken, playlistId, options) {
    const limit = Math.min(Math.max(options?.limit ?? maximumTracks, 1), maximumTracks);
    const path =
      playlistId === likesPlaylistId
        ? `/me/likes/tracks?limit=${limit}&linked_partitioning=1`
        : `/playlists/${encodeURIComponent(playlistId)}`;

    const payload = await get<unknown>(accessToken, path);
    const raw =
      playlistId === likesPlaylistId
        ? collectionOf<RawTrack>(payload)
        : ((payload as RawPlaylist | null)?.tracks ?? []);

    const tracks = raw
      .map(toTrack)
      .filter((track): track is ProviderTrack => track !== null);

    // The provider has no search inside one playlist, and a playlist is
    // bounded, so the filter runs here rather than costing a round trip.
    const query = options?.query ?? "";
    return (query ? tracks.filter((track) => matches(track, query)) : tracks).slice(
      0,
      limit,
    );
  },

  async getTracks(accessToken, ids) {
    if (ids.length === 0) return [];
    // No documented multi-get by URN, so these go one at a time -- but a few
    // at a time, not all at once. A 200-track room fired off in parallel is
    // 200 simultaneous requests from one click, which reads as an attack and
    // burns the ceiling the whole deployment shares.
    const queue = ids.slice(0, maximumTracks);
    const found: ProviderTrack[] = [];
    let next = 0;

    async function worker() {
      for (let index = next++; index < queue.length; index = next++) {
        try {
          const raw = await get<RawTrack>(
            accessToken,
            `/tracks/${encodeURIComponent(queue[index])}`,
          );
          const track = toTrack(raw);
          // A lookup that fails drops its row rather than failing the import;
          // the caller decides what an unresolved row means.
          if (track) found.push(track);
        } catch {
          // Same: one bad id must not cost the DJ the other 199.
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(lookupConcurrency, queue.length) }, worker),
    );
    return found;
  },

  async previewUrl(accessToken, providerTrackId) {
    const streams = await get<{
      preview_mp3_128_url?: string;
      hls_aac_160_url?: string;
    }>(accessToken, `/tracks/${encodeURIComponent(providerTrackId)}/streams`);
    // Only the progressive MP3 preview is used. The full-quality options are
    // HLS, which a bare <audio> element will not play outside Safari, and the
    // clip is the length this app offers anyway (previewSeconds).
    return streams.preview_mp3_128_url ?? null;
  },
};

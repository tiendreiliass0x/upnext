import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProvider, isProviderId, configuredProviders } from "@/lib/providers";
import { likesPlaylistId, soundcloud } from "@/lib/providers/soundcloud";
import { ProviderRequestError } from "@/lib/providers/types";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function stubFetch(handler: Handler) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const track = (overrides: Record<string, unknown> = {}) => ({
  id: 111,
  urn: "soundcloud:tracks:111",
  title: "Night Bus",
  duration: 214_000,
  permalink_url: "https://soundcloud.com/djowl/night-bus",
  artwork_url: "https://i1.sndcdn.com/artworks-abc-large.jpg",
  access: "playable",
  user: { username: "DJ Owl", permalink_url: "https://soundcloud.com/djowl" },
  ...overrides,
});

beforeEach(() => {
  process.env.SOUNDCLOUD_CLIENT_ID = "client-id";
  process.env.SOUNDCLOUD_CLIENT_SECRET = "client-secret";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SOUNDCLOUD_CLIENT_ID;
  delete process.env.SOUNDCLOUD_CLIENT_SECRET;
});

describe("provider registry", () => {
  it("only offers services this deployment has credentials for", () => {
    expect(configuredProviders().map((p) => p.id)).toEqual(["soundcloud"]);

    delete process.env.SOUNDCLOUD_CLIENT_ID;
    expect(configuredProviders()).toHaveLength(0);
  });

  it("does not resolve names that are not providers", () => {
    expect(getProvider("soundcloud")).toBe(soundcloud);
    expect(getProvider("spotify")).toBeNull();
    // A body could otherwise reach through Object.prototype.
    expect(getProvider("constructor")).toBeNull();
    expect(getProvider("toString")).toBeNull();
    expect(isProviderId("soundcloud")).toBe(true);
    expect(isProviderId("__proto__")).toBe(false);
  });
});

describe("soundcloud adapter", () => {
  it("asks for PKCE on the authorize URL", () => {
    const url = new URL(
      soundcloud.authorizeUrl({
        redirectUri: "https://upnext.example.com/api/connections/soundcloud/callback",
        state: "state-value",
        codeChallenge: "challenge-value",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://secure.soundcloud.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-value");
  });

  it("sends the code verifier when exchanging a code", async () => {
    const spy = stubFetch(() =>
      json({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "s" }),
    );
    const tokens = await soundcloud.exchangeCode({
      code: "the-code",
      codeVerifier: "the-verifier",
      redirectUri: "https://upnext.example.com/cb",
    });

    const body = String(spy.mock.calls[0][1]?.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code_verifier=the-verifier");
    expect(tokens).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresInSeconds: 3600,
      scopes: "s",
    });
  });

  it("surfaces a refused exchange rather than returning a blank token", async () => {
    stubFetch(() => json({ error: "invalid_grant" }, 400));
    await expect(
      soundcloud.exchangeCode({ code: "x", codeVerifier: "y", redirectUri: "z" }),
    ).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it("authenticates with OAuth, not Bearer", async () => {
    // Sending Bearer gets a 401 that looks exactly like an expired token,
    // which would send the refresh path into a loop.
    const spy = stubFetch(() => json({ id: 5, username: "DJ Owl" }));
    await soundcloud.me("the-token");

    const headers = spy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("OAuth the-token");
  });

  it("puts liked tracks at the top of the playlist list", async () => {
    stubFetch(() =>
      json({ collection: [{ id: 9, title: "Warmup", track_count: 12 }] }),
    );
    const playlists = await soundcloud.listPlaylists("token");

    expect(playlists[0].id).toBe(likesPlaylistId);
    expect(playlists[1]).toEqual({
      id: "9",
      title: "Warmup",
      trackCount: 12,
      artworkUrl: null,
    });
  });

  it("normalises a playlist's tracks and asks for bigger artwork", async () => {
    stubFetch(() => json({ tracks: [track()] }));
    const [normalised] = await soundcloud.listPlaylistTracks("token", "9");

    expect(normalised).toEqual({
      providerTrackId: "soundcloud:tracks:111",
      title: "Night Bus",
      artist: "DJ Owl",
      artworkUrl: "https://i1.sndcdn.com/artworks-abc-t500x500.jpg",
      durationMs: 214_000,
      permalinkUrl: "https://soundcloud.com/djowl/night-bus",
      uploaderName: "DJ Owl",
      access: "playable",
    });
  });

  it("keeps a blocked track visible to the caller, which decides", async () => {
    stubFetch(() => json({ tracks: [track({ access: "blocked" })] }));
    const [normalised] = await soundcloud.listPlaylistTracks("token", "9");
    expect(normalised.access).toBe("blocked");
  });

  it("treats a track it cannot describe as absent", async () => {
    stubFetch(() =>
      json({
        tracks: [
          // A removed or newly private entry arrives near-empty.
          { id: 1 },
          { id: 2, title: "No link" },
          track(),
        ],
      }),
    );
    const tracks = await soundcloud.listPlaylistTracks("token", "9");
    expect(tracks.map((item) => item.title)).toEqual(["Night Bus"]);
  });

  it("reads a track with no access field but streamable set", async () => {
    stubFetch(() =>
      json({ tracks: [track({ access: undefined, streamable: true })] }),
    );
    const [normalised] = await soundcloud.listPlaylistTracks("token", "9");
    expect(normalised.access).toBe("playable");
  });

  it("assumes no audio when neither access nor streamable says otherwise", async () => {
    // A row must never claim audio the guest's phone cannot actually get.
    stubFetch(() =>
      json({ tracks: [track({ access: undefined, streamable: undefined })] }),
    );
    const [normalised] = await soundcloud.listPlaylistTracks("token", "9");
    expect(normalised.access).toBe("blocked");
  });

  it("reads likes from their own endpoint", async () => {
    const spy = stubFetch(() => json({ collection: [track()] }));
    const tracks = await soundcloud.listPlaylistTracks("token", likesPlaylistId);

    expect(String(spy.mock.calls[0][0])).toContain("/me/likes/tracks");
    expect(tracks).toHaveLength(1);
  });

  it("filters a playlist locally, since the provider cannot search inside one", async () => {
    stubFetch(() =>
      json({ tracks: [track(), track({ id: 2, urn: "soundcloud:tracks:2", title: "Daybreak" })] }),
    );
    const tracks = await soundcloud.listPlaylistTracks("token", "9", {
      query: "daybr",
    });
    expect(tracks.map((item) => item.title)).toEqual(["Daybreak"]);
  });

  it("drops a track that fails to look up rather than failing the import", async () => {
    stubFetch((url) =>
      url.includes("111") ? json(track()) : json({ error: "gone" }, 404),
    );
    const tracks = await soundcloud.getTracks("token", [
      "soundcloud:tracks:111",
      "soundcloud:tracks:222",
    ]);
    expect(tracks.map((item) => item.providerTrackId)).toEqual([
      "soundcloud:tracks:111",
    ]);
  });

  it("does not fire a whole room's lookups at once", async () => {
    // 200 tracks in parallel from one click reads as an attack and burns the
    // daily ceiling the whole deployment shares.
    let inFlight = 0;
    let peak = 0;
    stubFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return json(track());
    });

    const ids = Array.from({ length: 60 }, (_, i) => `soundcloud:tracks:${i}`);
    await soundcloud.getTracks("token", ids);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
  });

  it("returns the progressive preview clip, never the HLS stream", async () => {
    // hls_aac_160_url will not play in a bare <audio> outside Safari, and the
    // clip is the length the app offers anyway.
    stubFetch(() =>
      json({
        hls_aac_160_url: "https://cf-hls-media.sndcdn.com/playlist.m3u8",
        preview_mp3_128_url: "https://cf-preview.sndcdn.com/preview.mp3",
      }),
    );
    expect(await soundcloud.previewUrl("token", "soundcloud:tracks:111")).toBe(
      "https://cf-preview.sndcdn.com/preview.mp3",
    );
  });

  it("returns null when a track has no clip at all", async () => {
    stubFetch(() => json({ hls_aac_160_url: "https://example/playlist.m3u8" }));
    expect(await soundcloud.previewUrl("token", "soundcloud:tracks:111")).toBeNull();
  });
});

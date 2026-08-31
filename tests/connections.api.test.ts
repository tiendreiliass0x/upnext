import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as saveAccount } from "@/app/api/accounts/route";
import { GET as listConnectionsRoute } from "@/app/api/connections/route";
import { DELETE as disconnectRoute } from "@/app/api/connections/[provider]/route";
import { POST as startRoute } from "@/app/api/connections/[provider]/start/route";
import { GET as callbackRoute } from "@/app/api/connections/[provider]/callback/route";
import { GET as playlistsRoute } from "@/app/api/connections/[provider]/playlists/route";
import { GET as playlistTracksRoute } from "@/app/api/connections/[provider]/playlists/[id]/tracks/route";
import { POST as createSessionRoute } from "@/app/api/sessions/route";
import { GET as previewRoute } from "@/app/api/tracks/[id]/preview/route";
import { getDatabase } from "@/lib/db";
import { setupTestDatabase } from "./helpers/database";

setupTestDatabase();

const key = Buffer.alloc(32, 5).toString("base64");
const base = "https://upnext.example.com";

function req(
  url: string,
  o: { method?: string; body?: unknown; token?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  return new Request(url, {
    method: o.method ?? "GET",
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
}
const body = <T,>(r: Response) => r.json() as Promise<T>;
const ctx = <T extends Record<string, string>>(params: T) => ({
  params: Promise.resolve(params),
});
const scParams = ctx({ provider: "soundcloud" });

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function stubFetch(handler: Handler) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

const trackPayload = {
  id: 111,
  urn: "soundcloud:tracks:111",
  title: "Night Bus",
  duration: 214_000,
  permalink_url: "https://soundcloud.com/djowl/night-bus",
  artwork_url: "https://i1.sndcdn.com/artworks-abc-large.jpg",
  access: "playable",
  user: { username: "DJ Owl" },
};

/** Answers the whole handshake plus the reads that follow it. */
function stubSoundCloud(overrides: { track?: unknown } = {}) {
  return stubFetch((url) => {
    if (url.includes("/oauth/token")) {
      return json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        scope: "non-expiring",
      });
    }
    if (url.includes("/me/playlists")) {
      return json({ collection: [{ id: 9, title: "Warmup", track_count: 2 }] });
    }
    if (url.includes("/me")) return json({ id: 5, username: "DJ Owl" });
    if (url.includes("/playlists/9")) {
      return json({ tracks: [overrides.track ?? trackPayload] });
    }
    if (url.includes("/tracks/")) return json(overrides.track ?? trackPayload);
    return json({ error: "unexpected" }, 404);
  });
}

async function dj(phone = "5551234567") {
  const r = await saveAccount(
    req(`${base}/api/accounts`, {
      method: "POST",
      body: { phone, pseudonym: "DJ Owl" },
    }),
  );
  return body<{ token: string; account: { id: string } }>(r);
}

/** Runs the whole connect handshake the way the popup would. */
async function connect(token: string) {
  const started = await startRoute(
    req(`${base}/api/connections/soundcloud/start`, { method: "POST", token }),
    scParams,
  );
  const { authorizeUrl } = await body<{ authorizeUrl: string }>(started);
  const state = new URL(authorizeUrl).searchParams.get("state") as string;
  const done = await callbackRoute(
    req(`${base}/api/connections/soundcloud/callback?code=c&state=${state}`),
    scParams,
  );
  expect(new URL(done.headers.get("location") as string).searchParams.get("status")).toBe(
    "ok",
  );
}

beforeEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = key;
  process.env.APP_PUBLIC_URL = base;
  process.env.SOUNDCLOUD_CLIENT_ID = "client-id";
  process.env.SOUNDCLOUD_CLIENT_SECRET = "client-secret";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TOKEN_ENCRYPTION_KEY;
  delete process.env.APP_PUBLIC_URL;
  delete process.env.SOUNDCLOUD_CLIENT_ID;
  delete process.env.SOUNDCLOUD_CLIENT_SECRET;
});

describe("connections API", () => {
  it("requires a signed-in account everywhere but the callback", async () => {
    for (const response of [
      await listConnectionsRoute(req(`${base}/api/connections`)),
      await startRoute(
        req(`${base}/api/connections/soundcloud/start`, { method: "POST" }),
        scParams,
      ),
      await disconnectRoute(
        req(`${base}/api/connections/soundcloud`, { method: "DELETE" }),
        scParams,
      ),
      await playlistsRoute(req(`${base}/api/connections/soundcloud/playlists`), scParams),
      await playlistTracksRoute(
        req(`${base}/api/connections/soundcloud/playlists/9/tracks`),
        ctx({ provider: "soundcloud", id: "9" }),
      ),
    ]) {
      expect(response.status).toBe(401);
    }
  });

  it("does not invent services it was never given credentials for", async () => {
    const { token } = await dj();
    const response = await startRoute(
      req(`${base}/api/connections/spotify/start`, { method: "POST", token }),
      ctx({ provider: "spotify" }),
    );
    expect(response.status).toBe(404);
  });

  it("says a service is unavailable rather than offering a dead button", async () => {
    const { token } = await dj();
    delete process.env.TOKEN_ENCRYPTION_KEY;

    const response = await startRoute(
      req(`${base}/api/connections/soundcloud/start`, { method: "POST", token }),
      scParams,
    );
    expect(response.status).toBe(503);

    const listed = await listConnectionsRoute(req(`${base}/api/connections`, { token }));
    const data = await body<{ available: Array<{ unavailableReason: string | null }> }>(
      listed,
    );
    expect(data.available[0].unavailableReason).toBeTruthy();
  });

  it("connects, lists, and never returns a token", async () => {
    stubSoundCloud();
    const { token, account } = await dj();
    await connect(token);

    const listed = await listConnectionsRoute(req(`${base}/api/connections`, { token }));
    const raw = await listed.text();
    expect(raw).toContain("DJ Owl");
    expect(raw).not.toContain("access-1");
    expect(raw).not.toContain("refresh-1");

    // Stored, and stored sealed.
    const stored = getDatabase()
      .prepare("SELECT access_token FROM provider_connections WHERE account_id = ?")
      .get(account.id) as { access_token: string };
    expect(stored.access_token).not.toContain("access-1");
  });

  it("sends the DJ back with a reason when the sign-in did not complete", async () => {
    for (const [query, status] of [
      ["error=access_denied", "denied"],
      ["code=only", "invalid"],
      ["code=c&state=never-issued", "expired"],
    ] as const) {
      const response = await callbackRoute(
        req(`${base}/api/connections/soundcloud/callback?${query}`),
        scParams,
      );
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get("location") as string);
      expect(location.pathname).toBe("/connect-done");
      expect(location.searchParams.get("status")).toBe(status);
    }
  });

  it("reads the DJ's own playlists and tracks", async () => {
    stubSoundCloud();
    const { token } = await dj();
    await connect(token);

    const playlists = await playlistsRoute(
      req(`${base}/api/connections/soundcloud/playlists`, { token }),
      scParams,
    );
    const listed = await body<{ playlists: Array<{ id: string; title: string }> }>(
      playlists,
    );
    expect(listed.playlists.map((p) => p.title)).toContain("Warmup");

    const tracks = await playlistTracksRoute(
      req(`${base}/api/connections/soundcloud/playlists/9/tracks`, { token }),
      ctx({ provider: "soundcloud", id: "9" }),
    );
    const found = await body<{ tracks: Array<{ title: string }> }>(tracks);
    expect(found.tracks.map((t) => t.title)).toEqual(["Night Bus"]);
  });

  it("never offers a track the service will not let anyone play", async () => {
    stubSoundCloud({ track: { ...trackPayload, access: "blocked" } });
    const { token } = await dj();
    await connect(token);

    const response = await playlistTracksRoute(
      req(`${base}/api/connections/soundcloud/playlists/9/tracks`, { token }),
      ctx({ provider: "soundcloud", id: "9" }),
    );
    expect((await body<{ tracks: unknown[] }>(response)).tracks).toHaveLength(0);
  });

  it("asks the DJ to reconnect when the grant is gone", async () => {
    stubSoundCloud();
    const { token, account } = await dj();
    await connect(token);

    // The saved grant stops working: expire it, then refuse the refresh.
    getDatabase()
      .prepare("UPDATE provider_connections SET access_expires_at = ? WHERE account_id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), account.id);
    stubFetch(() => json({ error: "invalid_grant" }, 400));

    const response = await playlistsRoute(
      req(`${base}/api/connections/soundcloud/playlists`, { token }),
      scParams,
    );
    expect(response.status).toBe(409);
    expect((await body<{ code: string }>(response)).code).toBe("RECONNECT");
  });

  it("disconnects, and says so even when there was nothing to disconnect", async () => {
    stubSoundCloud();
    const { token } = await dj();
    await connect(token);

    for (const _ of [0, 1]) {
      const response = await disconnectRoute(
        req(`${base}/api/connections/soundcloud`, { method: "DELETE", token }),
        scParams,
      );
      expect(response.status).toBe(200);
      void _;
    }
    const listed = await listConnectionsRoute(req(`${base}/api/connections`, { token }));
    expect((await body<{ connections: unknown[] }>(listed)).connections).toHaveLength(0);
  });
});

describe("importing a room from a connected service", () => {
  async function connectedDj() {
    const account = await dj();
    await connect(account.token);
    return account;
  }

  it("reads the metadata from the service, not from the request body", async () => {
    stubSoundCloud();
    const { token } = await connectedDj();

    const response = await createSessionRoute(
      req(`${base}/api/sessions`, {
        method: "POST",
        token,
        body: {
          name: "Friday",
          tracks: [
            {
              // Everything here that a guest would see is a lie.
              title: "Free Bitcoin",
              artist: "Definitely Not Phishing",
              provider: "soundcloud",
              providerTrackId: "soundcloud:tracks:111",
              permalinkUrl: "https://evil.example/steal",
              artworkUrl: "https://evil.example/tracker.gif",
            },
          ],
        },
      }),
    );
    expect(response.status).toBe(201);

    const data = await body<{
      session: {
        tracks: Array<{
          title: string;
          artworkUrl: string | null;
          source: { permalinkUrl: string; uploaderName: string } | null;
        }>;
      };
    }>(response);
    const [row] = data.session.tracks;
    expect(row.title).toBe("Night Bus");
    expect(row.source?.permalinkUrl).toBe("https://soundcloud.com/djowl/night-bus");
    expect(row.source?.uploaderName).toBe("DJ Owl");
    expect(row.artworkUrl).toContain("i1.sndcdn.com");
    expect(JSON.stringify(data)).not.toContain("evil.example");
  });

  it("leaves out songs the service will not play, and says how many", async () => {
    stubSoundCloud({ track: { ...trackPayload, access: "blocked" } });
    const { token } = await connectedDj();

    const response = await createSessionRoute(
      req(`${base}/api/sessions`, {
        method: "POST",
        token,
        body: {
          name: "Friday",
          tracks: [
            { title: "Uploaded", artist: "A" },
            {
              title: "Night Bus",
              artist: "DJ Owl",
              provider: "soundcloud",
              providerTrackId: "soundcloud:tracks:111",
            },
          ],
        },
      }),
    );
    expect(response.status).toBe(201);

    const data = await body<{
      skippedTracks: number;
      session: { tracks: Array<{ title: string }> };
    }>(response);
    expect(data.skippedTracks).toBe(1);
    expect(data.session.tracks.map((t) => t.title)).toEqual(["Uploaded"]);
  });

  it("opens the room anyway when the service cannot be reached", async () => {
    stubSoundCloud();
    const { token } = await connectedDj();
    // The DJ picked these while it was up; it going down at launch must not
    // cost them the room.
    stubFetch(() => json({ error: "down" }, 502));

    const response = await createSessionRoute(
      req(`${base}/api/sessions`, {
        method: "POST",
        token,
        body: {
          name: "Friday",
          tracks: [
            {
              title: "Night Bus",
              artist: "DJ Owl",
              provider: "soundcloud",
              providerTrackId: "soundcloud:tracks:111",
            },
          ],
        },
      }),
    );
    expect(response.status).toBe(201);
    const data = await body<{
      session: {
        tracks: Array<{ title: string; source: unknown; previewUrl: string | null }>;
      };
    }>(response);
    const [row] = data.session.tracks;
    expect(row.title).toBe("Night Bus");
    // Nothing the provider had to vouch for is claimed.
    expect(row.source).toBeNull();
    // And it must not advertise audio it cannot serve. A row that kept the
    // handle but lost the permalink would offer a control that 404s, and
    // would start serving the provider's audio with no credit attached the
    // moment they came back.
    expect(row.previewUrl).toBeNull();
  });

  it("does not resurrect audio for a row it could not vouch for", async () => {
    stubSoundCloud();
    const { token } = await connectedDj();
    stubFetch(() => json({ error: "down" }, 502));

    const created = await createSessionRoute(
      req(`${base}/api/sessions`, {
        method: "POST",
        token,
        body: {
          name: "Friday",
          tracks: [
            {
              title: "Night Bus",
              artist: "DJ Owl",
              provider: "soundcloud",
              providerTrackId: "soundcloud:tracks:111",
            },
          ],
        },
      }),
    );
    const data = await body<{ session: { tracks: Array<{ id: string }> } }>(created);

    // The service is back. The row still must not play: it was stored without
    // a provider claim, so there is nothing to resolve and nothing to credit.
    stubSoundCloud();
    const response = await previewRoute(
      req(`${base}/api/tracks/${data.session.tracks[0].id}/preview?as=json`),
      ctx({ id: data.session.tracks[0].id }),
    );
    expect(response.status).toBe(404);
  });

  it("returns the already-open room when a retry is sent", async () => {
    stubSoundCloud();
    const { token } = await connectedDj();
    const send = () =>
      createSessionRoute(
        req(`${base}/api/sessions`, {
          method: "POST",
          token,
          body: {
            name: "Friday",
            requestId: "same-request",
            tracks: [
              {
                title: "Night Bus",
                artist: "DJ Owl",
                provider: "soundcloud",
                providerTrackId: "soundcloud:tracks:111",
              },
            ],
          },
        }),
      );

    const first = await body<{ session: { id: string } }>(await send());

    // The DJ's first response was lost, and by the time they press Start again
    // the service reports the track blocked. The room is already open, so the
    // retry has to return it rather than refuse.
    stubSoundCloud({ track: { ...trackPayload, access: "blocked" } });
    const retry = await send();
    expect(retry.status).toBe(201);
    expect((await body<{ session: { id: string } }>(retry)).session.id).toBe(
      first.session.id,
    );
  });

  it("does not spend a provider call on a retry", async () => {
    const calls = stubSoundCloud();
    const { token } = await connectedDj();
    const send = () =>
      createSessionRoute(
        req(`${base}/api/sessions`, {
          method: "POST",
          token,
          body: {
            name: "Friday",
            requestId: "same-request",
            tracks: [
              {
                title: "Night Bus",
                artist: "DJ Owl",
                provider: "soundcloud",
                providerTrackId: "soundcloud:tracks:111",
              },
            ],
          },
        }),
      );

    await send();
    const before = calls.mock.calls.length;
    await send();
    expect(calls.mock.calls.length).toBe(before);
  });

  it("ignores a provider handle from a DJ who never connected", async () => {
    const { token } = await dj("5550000009");
    const response = await createSessionRoute(
      req(`${base}/api/sessions`, {
        method: "POST",
        token,
        body: {
          name: "Friday",
          tracks: [
            {
              title: "Night Bus",
              artist: "DJ Owl",
              provider: "soundcloud",
              providerTrackId: "soundcloud:tracks:111",
            },
          ],
        },
      }),
    );
    expect(response.status).toBe(201);
    const data = await body<{ session: { tracks: Array<{ source: unknown }> } }>(
      response,
    );
    expect(data.session.tracks[0].source).toBeNull();
  });
});

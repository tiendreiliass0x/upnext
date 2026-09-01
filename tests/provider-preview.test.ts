import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const r2Mocks = vi.hoisted(() => ({ getPreviewUrl: vi.fn() }));
vi.mock("@/lib/r2", () => ({ getPreviewUrl: r2Mocks.getPreviewUrl }));

import { POST as saveAccount } from "@/app/api/accounts/route";
import { POST as startRoute } from "@/app/api/connections/[provider]/start/route";
import { GET as callbackRoute } from "@/app/api/connections/[provider]/callback/route";
import { POST as createSessionRoute } from "@/app/api/sessions/route";
import { DELETE as disconnectRoute } from "@/app/api/connections/[provider]/route";
import { GET as previewRoute } from "@/app/api/tracks/[id]/preview/route";
import { clearProviderPreviewCache } from "@/lib/provider-preview";
import { getDatabase } from "@/lib/db";
import { setupTestDatabase } from "./helpers/database";

setupTestDatabase();

const base = "https://upnext.example.com";
const previewMp3 = "https://cf-preview.sndcdn.com/preview.mp3";

function req(url: string, o: { method?: string; body?: unknown; token?: string } = {}) {
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

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const trackPayload = {
  urn: "soundcloud:tracks:111",
  title: "Night Bus",
  duration: 214_000,
  permalink_url: "https://soundcloud.com/djowl/night-bus",
  access: "playable",
  user: { username: "DJ Owl" },
};

let streamCalls = 0;

function stubSoundCloud(streams: unknown = { preview_mp3_128_url: previewMp3 }) {
  streamCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return json({ access_token: "a", refresh_token: "r", expires_in: 3600 });
      }
      if (url.includes("/streams")) {
        streamCalls += 1;
        return json(streams);
      }
      if (url.includes("/me")) return json({ id: 5, username: "DJ Owl" });
      return json(trackPayload);
    }),
  );
}

async function importedRoom() {
  const account = await body<{ token: string }>(
    await saveAccount(
      req(`${base}/api/accounts`, {
        method: "POST",
        body: { phone: "5551234567", pseudonym: "DJ Owl" },
      }),
    ),
  );
  const scParams = ctx({ provider: "soundcloud" });
  const started = await startRoute(
    req(`${base}/api/connections/soundcloud/start`, { method: "POST", token: account.token }),
    scParams,
  );
  const { authorizeUrl } = await body<{ authorizeUrl: string }>(started);
  await callbackRoute(
    req(
      `${base}/api/connections/soundcloud/callback?code=c&state=${new URL(authorizeUrl).searchParams.get("state")}`,
    ),
    scParams,
  );

  const created = await createSessionRoute(
    req(`${base}/api/sessions`, {
      method: "POST",
      token: account.token,
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
  const data = await body<{
    session: { id: string; tracks: Array<{ id: string; previewUrl: string | null }> };
    hostKey: string;
  }>(created);
  return { ...data, token: account.token };
}

function askPreview(trackId: string) {
  return previewRoute(
    req(`${base}/api/tracks/${trackId}/preview?as=json`),
    ctx({ id: trackId }),
  );
}

beforeEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
  process.env.APP_PUBLIC_URL = base;
  process.env.SOUNDCLOUD_CLIENT_ID = "client-id";
  process.env.SOUNDCLOUD_CLIENT_SECRET = "client-secret";
  clearProviderPreviewCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  r2Mocks.getPreviewUrl.mockReset();
  delete process.env.TOKEN_ENCRYPTION_KEY;
  delete process.env.APP_PUBLIC_URL;
  delete process.env.SOUNDCLOUD_CLIENT_ID;
  delete process.env.SOUNDCLOUD_CLIENT_SECRET;
});

describe("previewing an imported row", () => {
  it("offers a pre-listen on the same URL an upload uses", async () => {
    stubSoundCloud();
    const { session } = await importedRoom();
    // The client cannot tell the two kinds of row apart, which is the point.
    expect(session.tracks[0].previewUrl).toBe(
      `/api/tracks/${session.tracks[0].id}/preview`,
    );
  });

  it("resolves the clip from the service, unauthenticated", async () => {
    stubSoundCloud();
    const { session } = await importedRoom();

    // No account token: a guest in the room is anonymous.
    const response = await askPreview(session.tracks[0].id);
    expect(response.status).toBe(200);
    expect((await body<{ url: string }>(response)).url).toBe(previewMp3);
  });

  it("costs one call per song, not one per listener", async () => {
    stubSoundCloud();
    const { session } = await importedRoom();
    const trackId = session.tracks[0].id;

    for (const _ of [0, 1, 2, 3, 4]) {
      expect((await askPreview(trackId)).status).toBe(200);
      void _;
    }
    expect(streamCalls).toBe(1);
  });

  it("says a row has no audio when the service offers no clip", async () => {
    stubSoundCloud({ hls_aac_160_url: "https://example/playlist.m3u8" });
    const { session } = await importedRoom();

    const response = await askPreview(session.tracks[0].id);
    expect(response.status).toBe(404);
  });

  it("degrades to no audio rather than erroring when the service is down", async () => {
    stubSoundCloud();
    const { session } = await importedRoom();
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "down" }, 502)));

    const response = await askPreview(session.tracks[0].id);
    expect(response.status).toBe(404);
  });

  it("stops serving a row once its room is over, even a warmed one", async () => {
    stubSoundCloud();
    const { session } = await importedRoom();
    const trackId = session.tracks[0].id;

    // Warm the cache first: this is the state a real room is in when it ends,
    // and a cached URL that outlives the gate keeps handing out the
    // provider's audio for as long as the entry lives.
    expect((await askPreview(trackId)).status).toBe(200);

    getDatabase()
      .prepare("UPDATE sessions SET ended_at = ? WHERE id = ?")
      .run(new Date().toISOString(), session.id);

    expect((await askPreview(trackId)).status).toBe(404);
  });

  it("stops serving a warmed row once the DJ disconnects the account", async () => {
    stubSoundCloud();
    const { session, token } = await importedRoom();
    const trackId = session.tracks[0].id;
    expect((await askPreview(trackId)).status).toBe(200);

    await disconnectRoute(
      new Request(`${base}/api/connections/soundcloud`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }),
      ctx({ provider: "soundcloud" }),
    );

    expect((await askPreview(trackId)).status).toBe(404);
  });

  it("does not reach for R2 on a row that never had an upload", async () => {
    stubSoundCloud();
    const { session } = await importedRoom();
    await askPreview(session.tracks[0].id);
    expect(r2Mocks.getPreviewUrl).not.toHaveBeenCalled();
  });
});

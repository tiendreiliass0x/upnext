import { afterEach, describe, expect, it, vi } from "vitest";

const r2Mocks = vi.hoisted(() => ({ getPreviewUrl: vi.fn() }));
vi.mock("@/lib/r2", () => ({ getPreviewUrl: r2Mocks.getPreviewUrl }));

import { POST as saveAccount } from "@/app/api/accounts/route";
import { GET as searchCatalogueRoute } from "@/app/api/catalogue/route";
import { GET as listPlaylistsRoute, POST as createPlaylistRoute } from "@/app/api/playlists/route";
import { DELETE as deletePlaylistRoute, GET as getPlaylistRoute } from "@/app/api/playlists/[id]/route";
import { POST as addTrackRoute } from "@/app/api/playlists/[id]/tracks/route";
import { DELETE as removeTrackRoute } from "@/app/api/playlists/[id]/tracks/[trackId]/route";
import { GET as previewRoute } from "@/app/api/library-tracks/[id]/preview/route";
import { adminTokenHeader } from "@/lib/admin";
import { addLibraryTrack, createLibrary } from "@/lib/libraries";
import { createPlaylist, maximumPlaylistsPerAccount } from "@/lib/playlists";
import { registerAudioUpload } from "@/lib/sessions";
import { setupTestDatabase } from "./helpers/database";

setupTestDatabase();
const originalAdminToken = process.env.ADMIN_TOKEN;
afterEach(() => {
  r2Mocks.getPreviewUrl.mockReset();
  if (originalAdminToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = originalAdminToken;
});

function req(
  url: string,
  o: { method?: string; body?: unknown; token?: string; admin?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.admin) headers[adminTokenHeader] = o.admin;
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

async function dj(phone: string) {
  const r = await saveAccount(
    req("http://localhost/api/accounts", { method: "POST", body: { phone, pseudonym: "DJ Person" } }),
  );
  return body<{ token: string; account: { id: string } }>(r);
}

async function playlist(token: string, name = "Set") {
  const r = await createPlaylistRoute(
    req("http://localhost/api/playlists", { method: "POST", token, body: { name } }),
  );
  expect(r.status).toBe(201);
  return (await body<{ playlist: { id: string } }>(r)).playlist;
}

function catalogueSong(libraryId: string, title: string, previewKey: string | null = null) {
  const added = addLibraryTrack({ libraryId, title, artist: "A", previewKey, contributedBy: null });
  if (typeof added !== "object" || added === null) throw new Error("not added");
  return added;
}

describe("play API", () => {
  it("requires a signed-in account everywhere", async () => {
    for (const response of [
      await searchCatalogueRoute(req("http://localhost/api/catalogue")),
      await listPlaylistsRoute(req("http://localhost/api/playlists")),
    ]) {
      expect(response.status).toBe(401);
    }
  });

  it("searches the whole catalogue, not one library", async () => {
    const account = await dj("+32470004001");
    const house = createLibrary({ name: "House", description: "" });
    const afro = createLibrary({ name: "Afro", description: "" });
    catalogueSong(house.id, "Sunrise Dub");
    catalogueSong(afro.id, "Sunrise Kora");
    catalogueSong(afro.id, "Moonfall");

    const found = await searchCatalogueRoute(
      req("http://localhost/api/catalogue?q=sunrise", { token: account.token }),
    );
    const data = await body<{ tracks: Array<{ title: string; libraryName: string }> }>(found);
    expect(data.tracks.map((t) => t.title).sort()).toEqual(["Sunrise Dub", "Sunrise Kora"]);
    // Each result says which shelf it came from.
    expect(data.tracks.map((t) => t.libraryName).sort()).toEqual(["Afro", "House"]);
  });

  it("hides another DJ's playlist behind a 404, not a 403", async () => {
    const mine = await dj("+32470004002");
    const theirs = await dj("+32470004003");
    const created = await playlist(mine.token);

    const peeked = await getPlaylistRoute(
      req(`http://localhost/api/playlists/${created.id}`, { token: theirs.token }),
      ctx({ id: created.id }),
    );
    // Existence is not information the other DJ is entitled to.
    expect(peeked.status).toBe(404);

    const deleted = await deletePlaylistRoute(
      req(`http://localhost/api/playlists/${created.id}`, { method: "DELETE", token: theirs.token }),
      ctx({ id: created.id }),
    );
    expect(deleted.status).toBe(404);
  });

  it("adds, lists in order, and removes", async () => {
    const account = await dj("+32470004004");
    const library = createLibrary({ name: "L", description: "" });
    const created = await playlist(account.token);
    const first = catalogueSong(library.id, "First");
    const second = catalogueSong(library.id, "Second");

    for (const track of [first, second]) {
      const added = await addTrackRoute(
        req(`http://localhost/api/playlists/${created.id}/tracks`, {
          method: "POST", token: account.token, body: { trackId: track.id },
        }),
        ctx({ id: created.id }),
      );
      expect(added.status).toBe(201);
    }

    // A repeat add is the same outcome, so 200 rather than an error.
    const repeat = await addTrackRoute(
      req(`http://localhost/api/playlists/${created.id}/tracks`, {
        method: "POST", token: account.token, body: { trackId: first.id },
      }),
      ctx({ id: created.id }),
    );
    expect(repeat.status).toBe(200);

    const listed = await getPlaylistRoute(
      req(`http://localhost/api/playlists/${created.id}`, { token: account.token }),
      ctx({ id: created.id }),
    );
    expect(
      (await body<{ tracks: Array<{ title: string }> }>(listed)).tracks.map((t) => t.title),
    ).toEqual(["First", "Second"]);

    const removed = await removeTrackRoute(
      req(`http://localhost/api/playlists/${created.id}/tracks/${first.id}`, {
        method: "DELETE", token: account.token,
      }),
      ctx({ id: created.id, trackId: first.id }),
    );
    expect(removed.status).toBe(200);
  });

  it("adds an entire library to a playlist without copying songs", async () => {
    const account = await dj("+32470004007");
    const library = createLibrary({ name: "L", description: "" });
    const created = await playlist(account.token);
    catalogueSong(library.id, "First");
    catalogueSong(library.id, "Second");

    const added = await addTrackRoute(
      req(`http://localhost/api/playlists/${created.id}/tracks`, {
        method: "POST",
        token: account.token,
        body: { libraryId: library.id },
      }),
      ctx({ id: created.id }),
    );

    expect(added.status).toBe(201);
    expect(await body(added)).toEqual({ added: 2, full: false });
  });

  it("hands the player a signed URL as JSON, since audio cannot send a bearer header", async () => {
    const account = await dj("+32470004005");
    const library = createLibrary({ name: "L", description: "" });
    registerAudioUpload({
      objectKey: "previews/a/one.mp3", accountId: account.account.id,
      originalName: "one.mp3", requestId: null,
    });
    const track = catalogueSong(library.id, "Playable", "previews/a/one.mp3");
    r2Mocks.getPreviewUrl.mockResolvedValue("https://r2.example/signed?sig=abc");

    const asJson = await previewRoute(
      req(`http://localhost/api/library-tracks/${track.id}/preview?as=json`, { token: account.token }),
      ctx({ id: track.id }),
    );
    expect(asJson.status).toBe(200);
    expect((await body<{ url: string }>(asJson)).url).toBe("https://r2.example/signed?sig=abc");

    // The redirect form still works for anything that follows redirects.
    const asRedirect = await previewRoute(
      req(`http://localhost/api/library-tracks/${track.id}/preview`, { token: account.token }),
      ctx({ id: track.id }),
    );
    expect(asRedirect.status).toBe(307);
    // A signed, short-lived URL must never be served from a cache to the next caller.
    expect(asRedirect.headers.get("Cache-Control")).toBe("no-store");

    // And it is still gated.
    const anonymous = await previewRoute(
      req(`http://localhost/api/library-tracks/${track.id}/preview?as=json`),
      ctx({ id: track.id }),
    );
    expect(anonymous.status).toBe(401);
  });
});

describe("play API bounds", () => {
  it("answers 409 once the account is at its playlist limit", async () => {
    const account = await dj("+32470004006");
    for (let index = 0; index < maximumPlaylistsPerAccount; index += 1) {
      createPlaylist({ accountId: account.account.id, name: `Set ${index}` });
    }
    const response = await createPlaylistRoute(
      req("http://localhost/api/playlists", {
        method: "POST",
        token: account.token,
        body: { name: "One more" },
      }),
    );
    expect(response.status).toBe(409);
    expect((await body<{ error: string }>(response)).error).toMatch(/limit/i);

    process.env.ADMIN_TOKEN = "super-admin";
    const elevated = await createPlaylistRoute(
      req("http://localhost/api/playlists", {
        method: "POST",
        token: account.token,
        admin: "super-admin",
        body: { name: "One more" },
      }),
    );
    expect(elevated.status).toBe(201);
  });
});

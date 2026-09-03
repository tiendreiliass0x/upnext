import { afterEach, describe, expect, it } from "vitest";
import { POST as saveAccount } from "@/app/api/accounts/route";
import { GET as listLibs, POST as createLib } from "@/app/api/libraries/route";
import { DELETE as deleteLib } from "@/app/api/libraries/[id]/route";
import {
  GET as listTracks,
  POST as addTrack,
} from "@/app/api/libraries/[id]/tracks/route";
import { DELETE as deleteTrack } from "@/app/api/library-tracks/[id]/route";
import { adminTokenHeader } from "@/lib/admin";
import { addLibraryTrack } from "@/lib/libraries";
import { registerAudioUpload } from "@/lib/sessions";
import { setupTestDatabase } from "./helpers/database";

setupTestDatabase();

const ADMIN = "test-admin-secret-token";
const original = process.env.ADMIN_TOKEN;
afterEach(() => {
  if (original === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = original;
});

function req(
  url: string,
  o: {
    method?: string;
    body?: unknown;
    token?: string;
    admin?: string;
  } = {},
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
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const body = <T,>(r: Response) => r.json() as Promise<T>;

async function dj(phone: string) {
  const r = await saveAccount(
    req("http://localhost/api/accounts", {
      method: "POST",
      body: { phone, pseudonym: "DJ Person" },
    }),
  );
  return (await body<{ token: string; account: { id: string } }>(r));
}

async function makeLibrary(name = "House") {
  process.env.ADMIN_TOKEN = ADMIN;
  const r = await createLib(
    req("http://localhost/api/libraries", {
      method: "POST",
      admin: ADMIN,
      body: { name, description: "d" },
    }),
  );
  expect(r.status).toBe(201);
  return (await body<{ library: { id: string } }>(r)).library;
}

describe("library API", () => {
  it("hides the admin surface entirely when no secret is configured", async () => {
    delete process.env.ADMIN_TOKEN;
    const created = await createLib(
      req("http://localhost/api/libraries", {
        method: "POST",
        admin: "guessed",
        body: { name: "X" },
      }),
    );
    // 404, not 403: an unconfigured admin area should not advertise itself.
    expect(created.status).toBe(404);
  });

  it("rejects a wrong secret once one is configured", async () => {
    process.env.ADMIN_TOKEN = ADMIN;
    const created = await createLib(
      req("http://localhost/api/libraries", {
        method: "POST",
        admin: "wrong",
        body: { name: "X" },
      }),
    );
    expect(created.status).toBe(403);
  });

  it("requires a name of a sensible length", async () => {
    process.env.ADMIN_TOKEN = ADMIN;
    for (const name of ["", "   ", "x".repeat(81)]) {
      const r = await createLib(
        req("http://localhost/api/libraries", {
          method: "POST",
          admin: ADMIN,
          body: { name },
        }),
      );
      expect(r.status).toBe(400);
    }
  });

  it("lets any signed-in DJ browse but not create", async () => {
    const library = await makeLibrary();
    const account = await dj("+32470002001");

    const anonymous = await listLibs(req("http://localhost/api/libraries"));
    expect(anonymous.status).toBe(401);

    const asDj = await listLibs(
      req("http://localhost/api/libraries", { token: account.token }),
    );
    expect(asDj.status).toBe(200);
    const listed = await body<{ libraries: Array<{ id: string; trackCount: number }> }>(asDj);
    expect(listed.libraries.map((l) => l.id)).toEqual([library.id]);
    expect(listed.libraries[0].trackCount).toBe(0);

    const attempted = await createLib(
      req("http://localhost/api/libraries", {
        method: "POST",
        token: account.token,
        body: { name: "Mine" },
      }),
    );
    expect(attempted.status).toBe(403);
  });

  it("lets a DJ contribute a song and records who did", async () => {
    const library = await makeLibrary();
    const account = await dj("+32470002002");
    registerAudioUpload({
      objectKey: "previews/dj/contributed.mp3",
      accountId: account.account.id,
      originalName: "c.mp3",
      requestId: null,
    });

    const added = await addTrack(
      req(`http://localhost/api/libraries/${library.id}/tracks`, {
        method: "POST",
        token: account.token,
        body: {
          title: "Contributed",
          artist: "DJ Person",
          previewKey: "previews/dj/contributed.mp3",
        },
      }),
      ctx(library.id),
    );
    expect(added.status).toBe(201);
    const track = (await body<{ track: { contributedBy: string; previewUrl: string } }>(added)).track;
    expect(track.contributedBy).toBe(account.account.id);
    expect(track.previewUrl).toContain("/preview");
  });

  it("refuses a preview key with no upload behind it", async () => {
    const library = await makeLibrary();
    const account = await dj("+32470002003");
    const added = await addTrack(
      req(`http://localhost/api/libraries/${library.id}/tracks`, {
        method: "POST",
        token: account.token,
        body: { title: "Fake", previewKey: "previews/other/guessed.mp3" },
      }),
      ctx(library.id),
    );
    expect(added.status).toBe(400);
  });

  it("searches within a library", async () => {
    const library = await makeLibrary();
    const account = await dj("+32470002004");
    for (const title of ["Sunrise", "Moonfall"]) {
      await addTrack(
        req(`http://localhost/api/libraries/${library.id}/tracks`, {
          method: "POST",
          token: account.token,
          body: { title, artist: "A" },
        }),
        ctx(library.id),
      );
    }
    const found = await listTracks(
      req(`http://localhost/api/libraries/${library.id}/tracks?q=moon`, {
        token: account.token,
      }),
      ctx(library.id),
    );
    expect(
      (await body<{ tracks: Array<{ title: string }> }>(found)).tracks.map((t) => t.title),
    ).toEqual(["Moonfall"]);
  });

  it("lets the admin read the complete library", async () => {
    const library = await makeLibrary();
    const account = await dj("+32470002006");
    for (let index = 0; index < 201; index += 1) {
      addLibraryTrack({
        libraryId: library.id,
        title: `Song ${String(index).padStart(3, "0")}`,
        artist: "A",
        previewKey: null,
        contributedBy: null,
      });
    }

    const normal = await listTracks(
      req(`http://localhost/api/libraries/${library.id}/tracks`, {
        token: account.token,
      }),
      ctx(library.id),
    );
    const elevated = await listTracks(
      req(`http://localhost/api/libraries/${library.id}/tracks`, {
        token: account.token,
        admin: ADMIN,
      }),
      ctx(library.id),
    );

    expect((await body<{ tracks: unknown[] }>(normal)).tracks).toHaveLength(200);
    expect((await body<{ tracks: unknown[] }>(elevated)).tracks).toHaveLength(201);
  });

  it("keeps removal with the admin, since anyone may contribute", async () => {
    const library = await makeLibrary();
    const account = await dj("+32470002005");
    const added = await addTrack(
      req(`http://localhost/api/libraries/${library.id}/tracks`, {
        method: "POST",
        token: account.token,
        body: { title: "Removable", artist: "A" },
      }),
      ctx(library.id),
    );
    const trackId = (await body<{ track: { id: string } }>(added)).track.id;

    const byDj = await deleteTrack(
      req(`http://localhost/api/library-tracks/${trackId}`, {
        method: "DELETE",
        token: account.token,
      }),
      ctx(trackId),
    );
    expect(byDj.status).toBe(403);

    const byAdmin = await deleteTrack(
      req(`http://localhost/api/library-tracks/${trackId}`, {
        method: "DELETE",
        admin: ADMIN,
      }),
      ctx(trackId),
    );
    expect(byAdmin.status).toBe(200);
  });

  it("deletes a library and reports a missing one", async () => {
    const library = await makeLibrary();
    expect(
      (
        await deleteLib(
          req(`http://localhost/api/libraries/${library.id}`, {
            method: "DELETE",
            admin: ADMIN,
          }),
          ctx(library.id),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await deleteLib(
          req(`http://localhost/api/libraries/${library.id}`, {
            method: "DELETE",
            admin: ADMIN,
          }),
          ctx(library.id),
        )
      ).status,
    ).toBe(404);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const r2Mocks = vi.hoisted(() => ({
  uploadPreview: vi.fn(),
  deletePreview: vi.fn(),
  getPreviewUrl: vi.fn(),
}));

vi.mock("@/lib/r2", () => ({
  uploadPreview: r2Mocks.uploadPreview,
  deletePreview: r2Mocks.deletePreview,
  getPreviewUrl: r2Mocks.getPreviewUrl,
  signedReadSeconds: 900,
}));

import { PATCH as patchAccount } from "@/app/api/accounts/route";
import {
  DELETE as deleteAvatar,
  POST as postAvatar,
} from "@/app/api/accounts/avatar/route";
import { GET as getAvatar } from "@/app/api/avatars/[name]/route";
import {
  createAccount,
  getAccountByToken,
  setAccountAvatar,
} from "@/lib/accounts";
import { resetRateLimits } from "@/lib/rate-limit";
import { castAnonymousVote, createSession, getSession, toggleVote } from "@/lib/sessions";
import { setupTestDatabase } from "./helpers/database";

setupTestDatabase();

/** A PNG header stating a real pixel size, which the route now reads. */
function pngHeader(width = 512, height = 512) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const pngBytes = pngHeader();

function signUp(phone: string, pseudonym = "Night Owl") {
  return createAccount({ phone, pseudonym });
}

function patch(token: string | null, body: unknown) {
  return patchAccount(
    new Request("http://test/api/accounts", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

function avatarRequest(
  token: string | null,
  file?: File,
  contentLength: string | null = "1024",
) {
  const formData = new FormData();
  if (file) formData.append("file", file);
  return new Request("http://test/api/accounts/avatar", {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      // A browser sets this for a FormData body; the tests say so explicitly
      // because the route treats a bounded size as a precondition.
      ...(contentLength === null ? {} : { "content-length": contentLength }),
    },
    body: formData,
  });
}

function pngFile(
  name = "me.png",
  size = pngBytes.length,
  header = pngBytes,
) {
  const body = new Uint8Array(Math.max(size, header.length));
  body.set(header);
  return new File([Buffer.from(body)], name, { type: "image/png" });
}

async function json<T>(response: Response) {
  return (await response.json()) as T;
}

type AccountBody = {
  account?: {
    pseudonym: string;
    tagline: string;
    avatarUrl: string | null;
    id: string;
  };
  error?: string;
};

describe("editing a profile", () => {
  beforeEach(() => {
    resetRateLimits();
    r2Mocks.uploadPreview.mockResolvedValue(undefined);
    r2Mocks.deletePreview.mockResolvedValue(undefined);
    r2Mocks.getPreviewUrl.mockResolvedValue("https://r2.example/signed?sig=a");
  });

  it("refuses an unauthenticated edit, so knowing a name cannot rename its owner", async () => {
    signUp("+32470000401");
    expect((await patch(null, { pseudonym: "Impostor" })).status).toBe(401);
    expect((await patch("not-a-token", { pseudonym: "Impostor" })).status).toBe(401);
  });

  it("saves a new username and tagline", async () => {
    const account = signUp("+32470000402");

    const response = await patch(account.authToken, {
      pseudonym: "Mint Fox",
      tagline: "Resident at Room 02",
    });

    expect(response.status).toBe(200);
    expect((await json<AccountBody>(response)).account).toMatchObject({
      pseudonym: "Mint Fox",
      tagline: "Resident at Room 02",
    });
    expect(getAccountByToken(account.authToken)!.pseudonym).toBe("Mint Fox");
  });

  it("leaves a field alone when the form did not send it", async () => {
    const account = signUp("+32470000403", "Keeper");
    await patch(account.authToken, { tagline: "Vinyl only" });

    const stored = getAccountByToken(account.authToken)!;
    expect(stored.pseudonym).toBe("Keeper");
    expect(stored.tagline).toBe("Vinyl only");
  });

  it("refuses a body that is not an object at all", async () => {
    const account = signUp("+32470000406");

    // `null` parses fine and is not an object; reading a field off it threw.
    expect((await patch(account.authToken, null)).status).toBe(400);
    expect((await patch(account.authToken, "a string")).status).toBe(400);
  });

  it("refuses a name or tagline the room could not show", async () => {
    const account = signUp("+32470000404");

    const short = await patch(account.authToken, { pseudonym: "x" });
    expect(short.status).toBe(400);
    expect((await json<AccountBody>(short)).error).toMatch(/between 2 and 24/);

    const wrapped = await patch(account.authToken, { pseudonym: "Two\nLines" });
    expect(wrapped.status).toBe(400);

    const long = await patch(account.authToken, { tagline: "a".repeat(121) });
    expect(long.status).toBe(400);

    const wrongType = await patch(account.authToken, { pseudonym: 12 });
    expect(wrongType.status).toBe(400);

    expect(getAccountByToken(account.authToken)!.pseudonym).toBe("Night Owl");
  });

  it("nudges the rooms an edited profile appears in, so guests stop hearing 304", async () => {
    const host = signUp("+32470000405", "Old Name");
    const { session } = createSession({
      name: "Set",
      venue: "",
      accountId: host.id,
      requestId: crypto.randomUUID(),
      tracks: [{ title: "Opener", artist: "A" }],
    });
    const before = getSession(session.id)!.revision;

    await patch(host.authToken, { tagline: "Vinyl only" });

    const after = getSession(session.id)!;
    expect(after.revision).toBe(before + 1);
    expect(after.djTagline).toBe("Vinyl only");
  });
});

describe("a profile picture", () => {
  beforeEach(() => {
    resetRateLimits();
    r2Mocks.uploadPreview.mockResolvedValue(undefined);
    r2Mocks.deletePreview.mockResolvedValue(undefined);
    r2Mocks.getPreviewUrl.mockResolvedValue("https://r2.example/signed?sig=a");
  });

  it("stores the picture and hands back a URL that names no account", async () => {
    const account = signUp("+32470000411");

    const response = await postAvatar(avatarRequest(account.authToken, pngFile()));
    const { account: updated } = await json<AccountBody>(response);

    expect(response.status).toBe(200);
    const [objectKey, , contentType] = r2Mocks.uploadPreview.mock.calls[0];
    expect(objectKey).toMatch(/^avatars\/[0-9a-f-]{36}\.png$/);
    expect(contentType).toBe("image/png");
    expect(updated!.avatarUrl).toBe(`/api/avatars/${objectKey.slice("avatars/".length)}`);
    expect(updated!.avatarUrl).not.toContain(account.id);
  });

  it("refuses a file that is not one of the image formats", async () => {
    const account = signUp("+32470000412");
    const svg = new File([Buffer.from("<svg xmlns='x'><script/></svg>")], "x.svg", {
      type: "image/svg+xml",
    });

    const response = await postAvatar(avatarRequest(account.authToken, svg));

    expect(response.status).toBe(415);
    expect(r2Mocks.uploadPreview).not.toHaveBeenCalled();
    expect(getAccountByToken(account.authToken)!.avatarKey).toBeNull();
  });

  it("refuses a file over the ceiling and one that is not a file at all", async () => {
    const account = signUp("+32470000413");

    // Declared small, actually large: the file itself is still weighed.
    const big = await postAvatar(
      avatarRequest(account.authToken, pngFile("big.png", 3 * 1024 * 1024)),
    );
    expect(big.status).toBe(413);

    // Declared large: refused before the body is buffered at all.
    const declared = await postAvatar(
      avatarRequest(account.authToken, pngFile(), String(9 * 1024 * 1024)),
    );
    expect(declared.status).toBe(413);

    const missing = await postAvatar(avatarRequest(account.authToken));
    expect(missing.status).toBe(400);
    expect(r2Mocks.uploadPreview).not.toHaveBeenCalled();
  });

  it("insists on a declared size, so a chunked body cannot arrive unbounded", async () => {
    const account = signUp("+32470000418");

    // Number(null) is 0, so an absent header used to slip past the ceiling
    // and reach the call that buffers the whole body.
    const chunked = await postAvatar(avatarRequest(account.authToken, pngFile(), null));
    expect(chunked.status).toBe(411);

    const nonsense = await postAvatar(avatarRequest(account.authToken, pngFile(), "later"));
    expect(nonsense.status).toBe(400);

    expect(r2Mocks.uploadPreview).not.toHaveBeenCalled();
  });

  it("removes the picture it replaces, and keeps the old one when the store fails", async () => {
    const account = signUp("+32470000414");
    await postAvatar(avatarRequest(account.authToken, pngFile()));
    const first = getAccountByToken(account.authToken)!.avatarKey;

    await postAvatar(avatarRequest(account.authToken, pngFile()));
    const second = getAccountByToken(account.authToken)!.avatarKey;
    expect(second).not.toBe(first);
    expect(r2Mocks.deletePreview).toHaveBeenCalledWith(first);

    r2Mocks.deletePreview.mockClear();
    r2Mocks.uploadPreview.mockRejectedValueOnce(new Error("R2 unavailable"));
    const failed = await postAvatar(avatarRequest(account.authToken, pngFile()));
    expect(failed.status).toBe(500);
    // The picture in the room is the one that was already there.
    expect(getAccountByToken(account.authToken)!.avatarKey).toBe(second);
    expect(r2Mocks.deletePreview).not.toHaveBeenCalledWith(second);
  });

  it("goes back to the lettered bubble and drops the object", async () => {
    const account = signUp("+32470000415");
    await postAvatar(avatarRequest(account.authToken, pngFile()));
    const stored = getAccountByToken(account.authToken)!.avatarKey;

    const response = await deleteAvatar(
      new Request("http://test/api/accounts/avatar", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${account.authToken}` },
      }),
    );

    expect(response.status).toBe(200);
    expect((await json<AccountBody>(response)).account!.avatarUrl).toBeNull();
    expect(r2Mocks.deletePreview).toHaveBeenCalledWith(stored);
    expect(getAccountByToken(account.authToken)!.avatarKey).toBeNull();
  });

  it("does not nudge every room when there was no picture to remove", async () => {
    const host = signUp("+32470000419");
    const { session } = createSession({
      name: "Set",
      venue: "",
      accountId: host.id,
      requestId: crypto.randomUUID(),
      tracks: [{ title: "Opener", artist: "A" }],
    });
    const before = getSession(session.id)!.revision;

    const response = await deleteAvatar(
      new Request("http://test/api/accounts/avatar", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${host.authToken}` },
      }),
    );

    expect(response.status).toBe(200);
    // A no-op write would cost every guest in the room a full payload on
    // their next poll instead of a 304.
    expect(getSession(session.id)!.revision).toBe(before);
    expect(r2Mocks.deletePreview).not.toHaveBeenCalled();
  });

  it("refuses a picture that is cheap to send and ruinous to draw", async () => {
    const account = signUp("+32470000420");

    // A solid 10000x10000 PNG sits well under the byte ceiling and asks every
    // guest's browser for hundreds of megabytes to decode one small circle.
    const bomb = pngFile("bomb.png", 4096, pngHeader(10_000, 10_000));
    const response = await postAvatar(avatarRequest(account.authToken, bomb));

    expect(response.status).toBe(413);
    expect((await json<AccountBody>(response)).error).toMatch(/pixels on a side/);
    expect(r2Mocks.uploadPreview).not.toHaveBeenCalled();

    // A picture a phone actually takes still goes through.
    const photo = pngFile("photo.png", 4096, pngHeader(4032, 3024));
    expect((await postAvatar(avatarRequest(account.authToken, photo))).status).toBe(200);
  });

  it("names the key it actually replaced, not the one the request arrived with", async () => {
    const account = signUp("+32470000421");
    await postAvatar(avatarRequest(account.authToken, pngFile()));
    const first = getAccountByToken(account.authToken)!.avatarKey!;

    // A second upload carrying the pre-first snapshot, as a racing request
    // would. The replaced key has to be what the row actually held.
    const stale = { ...account, avatarKey: null, avatarUrl: null };
    const { replacedKey } = setAccountAvatar(stale, "avatars/replacement.png");

    expect(replacedKey).toBe(first);
  });

  it("stops serving a picture once it is no longer anyone's", async () => {
    const account = signUp("+32470000422");
    await postAvatar(avatarRequest(account.authToken, pngFile()));
    const name = getAccountByToken(account.authToken)!.avatarUrl!.split("/").pop()!;

    expect(
      (await getAvatar(new Request("http://test"), {
        params: Promise.resolve({ name }),
      })).status,
    ).toBe(307);

    // The object delete is best effort and can fail; the route must not keep
    // signing reads for a key nothing points at any more.
    r2Mocks.deletePreview.mockRejectedValueOnce(new Error("R2 unavailable"));
    await deleteAvatar(
      new Request("http://test/api/accounts/avatar", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${account.authToken}` },
      }),
    );

    const after = await getAvatar(new Request("http://test"), {
      params: Promise.resolve({ name }),
    });
    expect(after.status).toBe(404);
  });

  it("needs a token to change or drop a picture", async () => {
    expect((await postAvatar(avatarRequest(null, pngFile()))).status).toBe(401);
    const removal = await deleteAvatar(
      new Request("http://test/api/accounts/avatar", { method: "DELETE" }),
    );
    expect(removal.status).toBe(401);
  });

  it("rides along on the faces in a room, and never with an account ID", async () => {
    const host = signUp("+32470000416", "Host");
    const fan = signUp("+32470000417", "Amyr");
    await postAvatar(avatarRequest(host.authToken, pngFile()));
    await postAvatar(avatarRequest(fan.authToken, pngFile()));
    const { session } = createSession({
      name: "Set",
      venue: "",
      accountId: host.id,
      requestId: crypto.randomUUID(),
      tracks: [{ title: "Opener", artist: "A" }],
    });
    const trackId = getSession(session.id)!.tracks[0].id;
    toggleVote({ sessionId: session.id, trackId, accountId: fan.id, enabled: true });
    castAnonymousVote({ sessionId: session.id, trackId, voterId: "anon-voter-01" });

    const room = getSession(session.id)!;

    expect(room.djAvatarUrl).toMatch(/^\/api\/avatars\//);
    expect(room.tracks[0].voters[0]).toEqual({
      name: "Amyr",
      avatarUrl: getAccountByToken(fan.authToken)!.avatarUrl,
    });
    // An anonymous vote stays a blank bubble.
    expect(room.tracks[0].voters[1]).toEqual({ name: null, avatarUrl: null });
    expect(JSON.stringify(room)).not.toContain(fan.id);
  });

  it("serves a current picture name and refuses anything else", async () => {
    const account = signUp("+32470000423");
    await postAvatar(avatarRequest(account.authToken, pngFile()));
    const name = getAccountByToken(account.authToken)!.avatarUrl!.split("/").pop()!;

    const found = await getAvatar(new Request("http://test"), {
      params: Promise.resolve({ name }),
    });
    expect(found.status).toBe(307);
    expect(found.headers.get("location")).toBe("https://r2.example/signed?sig=a");
    expect(found.headers.get("cache-control")).toMatch(/^private, max-age=\d+$/);
    expect(r2Mocks.getPreviewUrl).toHaveBeenCalledWith(`avatars/${name}`);

    // Malformed, and well-formed but nobody's: both are simply not found.
    for (const bad of [
      "../../secrets.env",
      "anything.mp3",
      `${crypto.randomUUID()}.svg`,
      `${crypto.randomUUID()}.png`,
    ]) {
      const response = await getAvatar(new Request("http://test"), {
        params: Promise.resolve({ name: bad }),
      });
      expect(response.status).toBe(404);
    }
    expect(r2Mocks.getPreviewUrl).toHaveBeenCalledTimes(1);
  });

  it("answers 502 rather than a broken redirect when the store is unreachable", async () => {
    const account = signUp("+32470000424");
    await postAvatar(avatarRequest(account.authToken, pngFile()));
    const name = getAccountByToken(account.authToken)!.avatarUrl!.split("/").pop()!;
    r2Mocks.getPreviewUrl.mockRejectedValueOnce(new Error("R2 unavailable"));

    const response = await getAvatar(new Request("http://test"), {
      params: Promise.resolve({ name }),
    });

    expect(response.status).toBe(502);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mediaMocks = vi.hoisted(() => ({
  uploadPreview: vi.fn(),
  deletePreview: vi.fn(),
  getPreviewUrl: vi.fn(),
}));

vi.mock("@/lib/r2", () => ({
  uploadPreview: mediaMocks.uploadPreview,
  deletePreview: mediaMocks.deletePreview,
  getPreviewUrl: mediaMocks.getPreviewUrl,
}));

import {
  accountStorageQuota,
  GET as getUploadStatus,
  POST as upload,
} from "@/app/api/uploads/route";
import { resetRateLimits } from "@/lib/rate-limit";
import { GET as getPreview } from "@/app/api/tracks/[id]/preview/route";
import { createAccount } from "@/lib/accounts";
import {
  createSession,
  endSession,
  getAudioUploadByRequest,
  registerAudioUpload,
  setNowPlaying,
} from "@/lib/sessions";
import { setupTestDatabase } from "./helpers/database";

setupTestDatabase();

function uploadRequest(input: {
  token?: string;
  adminToken?: string;
  uploadId?: string;
  contentLength?: string | null;
  name?: string;
  body?: Uint8Array;
}) {
  const formData = new FormData();
  formData.append(
    "file",
    new File([Buffer.from(input.body ?? mp3Bytes)], input.name ?? "track.mp3", {
      type: "audio/mpeg",
    }),
  );
  const headers: Record<string, string> = {};
  if (input.token) headers.Authorization = `Bearer ${input.token}`;
  if (input.adminToken) headers["x-upnext-admin-token"] = input.adminToken;
  if (input.uploadId) headers["x-upnext-upload-id"] = input.uploadId;
  if (input.contentLength !== null) {
    headers["content-length"] = input.contentLength ?? "1024";
  }
  return new Request("http://localhost/api/uploads", {
    method: "POST",
    headers,
    body: formData,
  });
}

function uploadStatusRequest(token: string, uploadId: string) {
  return new Request(
    `http://localhost/api/uploads?requestId=${encodeURIComponent(uploadId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

const mp3Bytes = new Uint8Array([
  0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x00, 0, 0,
]);
const originalAdminToken = process.env.ADMIN_TOKEN;

afterEach(() => {
  if (originalAdminToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = originalAdminToken;
});

async function json<T>(response: Response) {
  return (await response.json()) as T;
}

describe("upload API", () => {
  beforeEach(() => {
    resetRateLimits();
    mediaMocks.uploadPreview.mockResolvedValue(undefined);
    mediaMocks.deletePreview.mockResolvedValue(undefined);
    mediaMocks.getPreviewUrl.mockResolvedValue(
      "https://signed.r2.example/preview.mp3",
    );
  });

  it("requires authentication and a bounded request body", async () => {
    const unauthorized = await upload(uploadRequest({}));
    expect(unauthorized.status).toBe(401);

    const account = createAccount({
      phone: "+32470000040",
      pseudonym: "Uploader",
    });
    const unbounded = await upload(
      uploadRequest({ token: account.authToken, contentLength: null }),
    );
    const oversized = await upload(
      uploadRequest({
        token: account.authToken,
        contentLength: String(62 * 1024 * 1024),
      }),
    );
    expect(unbounded.status).toBe(411);
    expect(oversized.status).toBe(413);
    expect(mediaMocks.uploadPreview).not.toHaveBeenCalled();
  });

  it("stores the file as sent, registers it, and deduplicates a retry", async () => {
    const account = createAccount({
      phone: "+32470000041",
      pseudonym: "Uploader",
    });
    const first = await upload(
      uploadRequest({
        token: account.authToken,
        uploadId: "stable-upload",
      }),
    );
    const firstBody = await json<{ previewKey: string }>(first);
    expect(first.status).toBe(200);
    expect(firstBody.previewKey).toMatch(
      new RegExp(`^audio/${account.id}/.+\\.mp3$`),
    );
    // The body streams to R2 with its length declared, rather than being
    // buffered a second time. No abort signal: a dropped connection must not
    // throw away a body that has already arrived.
    const [key, body, contentType, options] = mediaMocks.uploadPreview.mock.calls[0];
    expect(key).toBe(firstBody.previewKey);
    expect(typeof (body as { pipe?: unknown }).pipe).toBe("function");
    expect(contentType).toBe("audio/mpeg");
    expect(options).toEqual({ contentLength: mp3Bytes.length });
    expect(getAudioUploadByRequest(account.id, "stable-upload")).toBe(
      firstBody.previewKey,
    );

    const repeated = await upload(
      uploadRequest({
        token: account.authToken,
        uploadId: "stable-upload",
      }),
    );
    expect(await json(repeated)).toEqual({ previewKey: firstBody.previewKey });
    expect(mediaMocks.uploadPreview).toHaveBeenCalledTimes(1);
  });

  it("reports whether a timed-out upload is processing or ready", async () => {
    const account = createAccount({
      phone: "+32470000045",
      pseudonym: "Patient Uploader",
    });
    let finishUpload: (() => void) | undefined;
    mediaMocks.uploadPreview.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishUpload = resolve;
      }),
    );

    const pending = upload(
      uploadRequest({
        token: account.authToken,
        uploadId: "slow-upload",
      }),
    );
    await vi.waitFor(() => expect(mediaMocks.uploadPreview).toHaveBeenCalled());

    const processing = await getUploadStatus(
      uploadStatusRequest(account.authToken, "slow-upload"),
    );
    expect(processing.status).toBe(202);
    expect(await json(processing)).toEqual({ status: "processing" });
    const unrelated = await getUploadStatus(
      uploadStatusRequest(account.authToken, "different-upload"),
    );
    expect(unrelated.status).toBe(404);

    finishUpload?.();
    const completed = await pending;
    const completedBody = await json<{ previewKey: string }>(completed);
    const ready = await getUploadStatus(
      uploadStatusRequest(account.authToken, "slow-upload"),
    );
    expect(ready.status).toBe(200);
    expect(await json(ready)).toEqual({ previewKey: completedBody.previewKey });
  });

  it("rejects a file whose bytes are not audio, whatever its name says", async () => {
    const account = createAccount({
      phone: "+32470000044",
      pseudonym: "Uploader",
    });
    const response = await upload(
      uploadRequest({
        token: account.authToken,
        body: new Uint8Array(Array.from("<!doctype html><script>", (c) => c.charCodeAt(0))),
      }),
    );
    expect(response.status).toBe(415);
    expect(mediaMocks.uploadPreview).not.toHaveBeenCalled();
  });

  it("attempts R2 cleanup when an upload fails", async () => {
    const account = createAccount({
      phone: "+32470000042",
      pseudonym: "Uploader",
    });
    mediaMocks.uploadPreview.mockRejectedValueOnce(new Error("R2 unavailable"));

    const response = await upload(
      uploadRequest({
        token: account.authToken,
        uploadId: "failed-upload",
      }),
    );
    expect(response.status).toBe(500);
    expect(mediaMocks.deletePreview).toHaveBeenCalledTimes(1);
    expect(getAudioUploadByRequest(account.id, "failed-upload")).toBeNull();
  });
});

describe("preview API", () => {
  beforeEach(() => {
    mediaMocks.getPreviewUrl.mockResolvedValue(
      "https://signed.r2.example/preview.mp3",
    );
  });

  it("serves any row of a live room, and nothing once it ends", async () => {
    const account = createAccount({
      phone: "+32470000043",
      pseudonym: "Preview Host",
    });
    const objectKey = "previews/host/preview.mp3";
    registerAudioUpload({
      objectKey,
      accountId: account.id,
      originalName: "preview.mp3",
    });
    const created = createSession({
      name: "Preview Room",
      venue: "",
      accountId: account.id,
      tracks: [{ title: "Preview", artist: "Artist", previewKey: objectKey }],
    });
    const trackId = created.session.tracks[0].id;

    // A pre-listen, booth or crowd, asks for the URL as JSON and carries no
    // key: a row of a live room plays before the DJ has put it on.
    const audition = await getPreview(new Request("http://localhost/?as=json"), {
      params: Promise.resolve({ id: trackId }),
    });
    expect(audition.status).toBe(200);
    expect(audition.headers.get("cache-control")).toBe("no-store");
    expect(await audition.json()).toEqual({ url: "https://signed.r2.example/preview.mp3" });

    setNowPlaying({
      sessionId: created.session.id,
      hostKey: created.hostKey,
      accountId: account.id,
      trackId,
    });
    const response = await getPreview(new Request("http://localhost"), {
      params: Promise.resolve({ id: trackId }),
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://signed.r2.example/preview.mp3",
    );
    expect(mediaMocks.getPreviewUrl).toHaveBeenCalledWith(objectKey);

    endSession({
      sessionId: created.session.id,
      hostKey: created.hostKey,
      accountId: account.id,
    });
    const endedResponse = await getPreview(new Request("http://localhost"), {
      params: Promise.resolve({ id: trackId }),
    });
    expect(endedResponse.status).toBe(404);
  });

  it("refuses an upload that would push the account past its storage quota", async () => {
    const account = createAccount({
      phone: "+32470000045",
      pseudonym: "Hoarder",
    });
    registerAudioUpload({
      objectKey: `audio/${account.id}/big.wav`,
      accountId: account.id,
      originalName: "big.wav",
      sizeBytes: accountStorageQuota - 4,
    });
    const response = await upload(uploadRequest({ token: account.authToken }));
    expect(response.status).toBe(507);
    expect((await json<{ error: string }>(response)).error).toMatch(/storage is full/i);
    expect(mediaMocks.uploadPreview).not.toHaveBeenCalled();
  });

  it("does not apply the account storage quota to a super-admin upload", async () => {
    process.env.ADMIN_TOKEN = "super-admin";
    const account = createAccount({
      phone: "+32470000048",
      pseudonym: "Curator",
    });
    registerAudioUpload({
      objectKey: `audio/${account.id}/big.wav`,
      accountId: account.id,
      originalName: "big.wav",
      sizeBytes: accountStorageQuota,
    });

    const response = await upload(
      uploadRequest({
        token: account.authToken,
        adminToken: "super-admin",
      }),
    );

    expect(response.status).toBe(200);
    expect(mediaMocks.uploadPreview).toHaveBeenCalledTimes(1);
  });

  it("turns away a client whose own upload is still in flight, for free", async () => {
    const account = createAccount({
      phone: "+32470000047",
      pseudonym: "Batcher",
    });
    let release = () => {};
    mediaMocks.uploadPreview.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = () => resolve())),
    );
    const inFlight = upload(
      uploadRequest({ token: account.authToken, uploadId: "first" }),
    );
    await vi.waitFor(() =>
      expect(mediaMocks.uploadPreview).toHaveBeenCalledTimes(1),
    );

    const busy = await upload(
      uploadRequest({ token: account.authToken, uploadId: "second" }),
    );
    expect(busy.status).toBe(429);
    // Named, so the client waits that long instead of guessing at a retry.
    expect(busy.headers.get("Retry-After")).toBe("5");
    expect((await json<{ error: string }>(busy)).error).toMatch(/busy/i);

    release();
    await inFlight;

    // The bounce cost nothing: a full hour's worth of real uploads still
    // fits. A batch that is told to come back must not spend the budget it
    // is coming back to use.
    for (let index = 0; index < 59; index += 1) {
      await upload(uploadRequest({ token: account.authToken }));
    }
    expect(mediaMocks.uploadPreview).toHaveBeenCalledTimes(60);
    const limited = await upload(uploadRequest({ token: account.authToken }));
    expect(limited.status).toBe(429);
    expect((await json<{ error: string }>(limited)).error).toMatch(
      /too many attempts/i,
    );
  });

  it("rate limits uploads per account", async () => {
    const account = createAccount({
      phone: "+32470000046",
      pseudonym: "Scripter",
    });
    let last: Response | null = null;
    for (let index = 0; index < 61; index += 1) {
      last = await upload(uploadRequest({ token: account.authToken }));
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get("Retry-After")).toBeTruthy();
    expect(mediaMocks.uploadPreview).toHaveBeenCalledTimes(60);

    process.env.ADMIN_TOKEN = "super-admin";
    const elevated = await upload(
      uploadRequest({
        token: account.authToken,
        adminToken: "super-admin",
      }),
    );
    expect(elevated.status).toBe(200);
    expect(mediaMocks.uploadPreview).toHaveBeenCalledTimes(61);
  });
});

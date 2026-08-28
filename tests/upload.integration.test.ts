import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { accountStorageQuota, POST as upload } from "@/app/api/uploads/route";
import { resetRateLimits } from "@/lib/rate-limit";
import { GET as getPreview } from "@/app/api/tracks/[id]/preview/route";
import { createAccount } from "@/lib/accounts";
import {
  createSession,
  endSession,
  getAudioUploadByRequest,
  registerAudioUpload,
} from "@/lib/sessions";
import { setupTestDatabase } from "./helpers/database";

setupTestDatabase();

function uploadRequest(input: {
  token?: string;
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

const mp3Bytes = new Uint8Array([
  0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x00, 0, 0,
]);

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
    // buffered a second time; the request's own signal rides along.
    const [key, body, contentType, options] = mediaMocks.uploadPreview.mock.calls[0];
    expect(key).toBe(firstBody.previewKey);
    expect(typeof (body as { pipe?: unknown }).pipe).toBe("function");
    expect(contentType).toBe("audio/mpeg");
    expect(options).toMatchObject({ contentLength: mp3Bytes.length });
    expect((options as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
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

  it("redirects active previews and rejects them after room end", async () => {
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
  });
});

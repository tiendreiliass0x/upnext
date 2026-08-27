import { beforeEach, describe, expect, it, vi } from "vitest";

const mediaMocks = vi.hoisted(() => ({
  createPreview: vi.fn(),
  uploadPreview: vi.fn(),
  deletePreview: vi.fn(),
  getPreviewUrl: vi.fn(),
}));

vi.mock("@/lib/audio", () => ({
  createThirtySecondPreview: mediaMocks.createPreview,
}));
vi.mock("@/lib/r2", () => ({
  uploadPreview: mediaMocks.uploadPreview,
  deletePreview: mediaMocks.deletePreview,
  getPreviewUrl: mediaMocks.getPreviewUrl,
}));

import { POST as upload } from "@/app/api/uploads/route";
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
}) {
  const formData = new FormData();
  formData.append(
    "file",
    new File([Buffer.from("test audio")], input.name ?? "track.mp3", {
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

async function json<T>(response: Response) {
  return (await response.json()) as T;
}

describe("upload API", () => {
  beforeEach(() => {
    mediaMocks.createPreview.mockResolvedValue(Buffer.from("30-second-preview"));
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
        contentLength: String(42 * 1024 * 1024),
      }),
    );
    expect(unbounded.status).toBe(411);
    expect(oversized.status).toBe(413);
    expect(mediaMocks.createPreview).not.toHaveBeenCalled();
  });

  it("trims, uploads, registers, and deduplicates a retry", async () => {
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
      new RegExp(`^previews/${account.id}/.+\\.mp3$`),
    );
    expect(mediaMocks.createPreview).toHaveBeenCalledTimes(1);
    expect(mediaMocks.uploadPreview).toHaveBeenCalledWith(
      firstBody.previewKey,
      Buffer.from("30-second-preview"),
    );
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
    expect(mediaMocks.createPreview).toHaveBeenCalledTimes(1);
    expect(mediaMocks.uploadPreview).toHaveBeenCalledTimes(1);
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
});

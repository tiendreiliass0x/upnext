import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  send: vi.fn(),
  signedUrl: vi.fn(),
  clientConfig: undefined as unknown,
}));

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    constructor(config: unknown) {
      sdkMocks.clientConfig = config;
    }

    send(command: unknown) {
      return sdkMocks.send(command);
    }
  }

  class Command {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  return {
    S3Client,
    PutObjectCommand: class PutObjectCommand extends Command {},
    GetObjectCommand: class GetObjectCommand extends Command {},
    DeleteObjectCommand: class DeleteObjectCommand extends Command {},
    DeleteObjectsCommand: class DeleteObjectsCommand extends Command {},
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: sdkMocks.signedUrl,
}));

import {
  deletePreview,
  deletePreviews,
  getPreviewUrl,
  uploadPreview,
} from "@/lib/r2";

function clearR2Client() {
  delete (globalThis as typeof globalThis & { djBoothR2Client?: unknown })
    .djBoothR2Client;
}

describe("R2 adapter", () => {
  beforeEach(() => {
    clearR2Client();
    sdkMocks.send.mockReset().mockResolvedValue({});
    sdkMocks.signedUrl
      .mockReset()
      .mockResolvedValue("https://signed.example/preview.mp3");
    delete process.env.R2_ACCOUNT_ID;
    process.env.R2_ENDPOINT = "https://account.r2.cloudflarestorage.com";
    process.env.R2_ACCESS_KEY_ID = "access-key";
    process.env.R2_SECRET_ACCESS_KEY = "secret-key";
    process.env.R2_BUCKET = "dj-booth";
  });

  it("accepts an explicit endpoint without a separate account ID", async () => {
    await uploadPreview("previews/test.mp3", Buffer.from("audio"));

    expect(sdkMocks.clientConfig).toMatchObject({
      region: "auto",
      endpoint: "https://account.r2.cloudflarestorage.com",
      credentials: {
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
      },
    });
    const command = sdkMocks.send.mock.calls[0][0] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toMatchObject({
      Bucket: "dj-booth",
      Key: "previews/test.mp3",
      ContentType: "audio/mpeg",
    });
  });

  it("stores the caller's content type", async () => {
    await uploadPreview("audio/test.flac", Buffer.from("audio"), "audio/flac");
    const command = sdkMocks.send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({ ContentType: "audio/flac" });
  });

  it("deletes objects and signs short-lived reads", async () => {
    await deletePreview("previews/delete.mp3");
    const deleteCommand = sdkMocks.send.mock.calls[0][0] as {
      input: Record<string, unknown>;
    };
    expect(deleteCommand.input).toEqual({
      Bucket: "dj-booth",
      Key: "previews/delete.mp3",
    });

    await expect(getPreviewUrl("previews/read.mp3")).resolves.toBe(
      "https://signed.example/preview.mp3",
    );
    expect(sdkMocks.signedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        input: { Bucket: "dj-booth", Key: "previews/read.mp3" },
      }),
      { expiresIn: 900 },
    );
  });

  it("fails clearly when credentials are incomplete", async () => {
    delete process.env.R2_SECRET_ACCESS_KEY;
    clearR2Client();
    await expect(
      uploadPreview("previews/test.mp3", Buffer.from("audio")),
    ).rejects.toThrow("R2 credentials are incomplete");
    expect(sdkMocks.send).not.toHaveBeenCalled();
  });
});

describe("R2 batch deletion", () => {
  function configure() {
    delete (globalThis as typeof globalThis & { djBoothR2Client?: unknown })
      .djBoothR2Client;
    process.env.R2_ENDPOINT = "https://account.r2.cloudflarestorage.com";
    process.env.R2_ACCESS_KEY_ID = "access-key";
    process.env.R2_SECRET_ACCESS_KEY = "secret-key";
    process.env.R2_BUCKET = "dj-booth";
  }

  beforeEach(() => {
    configure();
    sdkMocks.send.mockReset().mockResolvedValue({});
  });

  it("does not call R2 for an empty list", async () => {
    await expect(deletePreviews([])).resolves.toEqual({
      deleted: [],
      failed: [],
    });
    expect(sdkMocks.send).not.toHaveBeenCalled();
  });

  it("reports keys R2 named in Errors as failed", async () => {
    sdkMocks.send.mockResolvedValue({
      Errors: [{ Key: "previews/b.mp3", Code: "AccessDenied" }],
    });

    await expect(
      deletePreviews(["previews/a.mp3", "previews/b.mp3", "previews/c.mp3"]),
    ).resolves.toEqual({
      deleted: ["previews/a.mp3", "previews/c.mp3"],
      failed: ["previews/b.mp3"],
    });
  });

  it("treats a missing Deleted list as success", async () => {
    sdkMocks.send.mockResolvedValue({});
    const result = await deletePreviews(["previews/a.mp3"]);
    expect(result).toEqual({ deleted: ["previews/a.mp3"], failed: [] });
  });

  it("splits large runs into batches of 1000", async () => {
    const keys = Array.from({ length: 2500 }, (_, index) => `previews/${index}.mp3`);

    const result = await deletePreviews(keys);

    expect(sdkMocks.send).toHaveBeenCalledTimes(3);
    const batchSizes = sdkMocks.send.mock.calls.map(
      ([command]) => (command as { input: { Delete: { Objects: unknown[] } } })
        .input.Delete.Objects.length,
    );
    expect(batchSizes).toEqual([1000, 1000, 500]);
    expect(result.deleted).toHaveLength(2500);
    expect(result.failed).toHaveLength(0);
  });

  it("fails only the batch that threw, keeping the others", async () => {
    const keys = Array.from({ length: 1500 }, (_, index) => `previews/${index}.mp3`);
    sdkMocks.send
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({});

    const result = await deletePreviews(keys);

    expect(result.failed).toHaveLength(1000);
    expect(result.deleted).toHaveLength(500);
    expect(result.deleted[0]).toBe("previews/1000.mp3");
  });
});

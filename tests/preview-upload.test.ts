// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/preview-client");
});

describe("preparing a file for upload", () => {
  it("uploads the original when the encoder chunk cannot be loaded", async () => {
    // Patchy venue wifi, or a redeploy that retired the chunk hash.
    vi.doMock("@/lib/preview-client", () => {
      throw new Error("Loading chunk 123 failed.");
    });
    const { prepareUploadFile } = await import("@/lib/preview-upload");
    const original = new File([new Uint8Array(9_000_000)], "song.flac");

    await expect(prepareUploadFile(original)).resolves.toBe(original);
  });

  it("uploads the trimmed clip when the encoder produces one", async () => {
    const clip = new File([new Uint8Array(400_000)], "song.mp3");
    const trimToPreview = vi.fn(async () => clip);
    vi.doMock("@/lib/preview-client", () => ({ trimToPreview }));
    const { prepareUploadFile } = await import("@/lib/preview-upload");
    const original = new File([new Uint8Array(9_000_000)], "song.flac");
    const onProgress = () => {};

    await expect(prepareUploadFile(original, onProgress)).resolves.toBe(clip);
    expect(trimToPreview).toHaveBeenCalledWith(original, onProgress);
  });

  it("uploads the original when the encoder declines", async () => {
    vi.doMock("@/lib/preview-client", () => ({
      trimToPreview: async () => null,
    }));
    const { prepareUploadFile } = await import("@/lib/preview-upload");
    const original = new File([new Uint8Array(100)], "tiny.mp3");

    await expect(prepareUploadFile(original)).resolves.toBe(original);
  });
});

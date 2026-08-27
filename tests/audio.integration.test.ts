import ffmpegPath from "ffmpeg-static";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createThirtySecondPreview } from "@/lib/audio";

const directory = mkdtempSync(join(tmpdir(), "upnext-audio-test-"));
const sourcePath = join(directory, "source.mp3");
const previewPath = join(directory, "preview.mp3");

describe("FFmpeg preview generation", () => {
  beforeAll(() => {
    if (!ffmpegPath) throw new Error("ffmpeg-static is unavailable");
    const generated = spawnSync(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=31",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "64k",
        sourcePath,
      ],
      { timeout: 20_000 },
    );
    if (generated.status !== 0) {
      throw new Error(generated.stderr.toString() || "Test audio generation failed");
    }
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it(
    "creates an MP3 trimmed to exactly 30 seconds",
    async () => {
      const preview = await createThirtySecondPreview(
        readFileSync(sourcePath),
        "source.mp3",
      );
      writeFileSync(previewPath, preview);

      const inspected = spawnSync(
        ffmpegPath as string,
        ["-hide_banner", "-i", previewPath, "-f", "null", "-"],
        { timeout: 20_000 },
      );
      expect(inspected.status).toBe(0);
      const duration = inspected.stderr
        .toString()
        .match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      expect(duration).not.toBeNull();
      const seconds =
        Number(duration?.[1]) * 3600 +
        Number(duration?.[2]) * 60 +
        Number(duration?.[3]);
      expect(seconds).toBeCloseTo(30, 1);
      expect(preview.length).toBeGreaterThan(100_000);
    },
    30_000,
  );

  it("rejects malformed audio", async () => {
    await expect(
      createThirtySecondPreview(Buffer.from("not audio"), "bad.mp3"),
    ).rejects.toThrow();
  });

  it("honors an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createThirtySecondPreview(
        readFileSync(sourcePath),
        "source.mp3",
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
  });
});

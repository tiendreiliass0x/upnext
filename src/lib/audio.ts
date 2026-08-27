import ffmpegStatic from "ffmpeg-static";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { spawn } from "node:child_process";

export async function createThirtySecondPreview(
  source: Buffer,
  originalName: string,
  signal?: AbortSignal,
) {
  const workDirectory = await mkdtemp(join(tmpdir(), "dj-booth-"));
  const extension = extname(originalName).replace(/[^a-z0-9.]/gi, "").slice(0, 8);
  const inputPath = join(workDirectory, `source${extension || ".audio"}`);
  const outputPath = join(workDirectory, "preview.mp3");
  const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStatic || "ffmpeg";

  try {
    await writeFile(inputPath, source);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-t",
        "30",
        "-vn",
        "-ac",
        "2",
        "-ar",
        "44100",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "128k",
        outputPath,
      ]);
      let errorOutput = "";
      let stoppedReason: "aborted" | "timeout" | null = null;
      let settled = false;
      let killTimeout: ReturnType<typeof setTimeout> | undefined;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimeout) clearTimeout(killTimeout);
        signal?.removeEventListener("abort", stopForAbort);
        if (error) reject(error);
        else resolve();
      };
      const stopForAbort = () => {
        stoppedReason = "aborted";
        child.kill("SIGKILL");
      };
      const timeout = setTimeout(() => {
        stoppedReason = "timeout";
        child.kill("SIGKILL");
        killTimeout = setTimeout(
          () => settle(new Error("Audio processing did not stop.")),
          5000,
        );
      }, 60_000);

      signal?.addEventListener("abort", stopForAbort, { once: true });
      if (signal?.aborted) stopForAbort();
      child.stderr.on("data", (chunk: Buffer) => {
        if (errorOutput.length < 4000) errorOutput += chunk.toString();
      });
      child.on("error", (error) => settle(error));
      child.on("close", (code) => {
        if (stoppedReason === "timeout") {
          settle(new Error("Audio processing timed out."));
        } else if (stoppedReason === "aborted") {
          settle(new Error("Audio upload was cancelled."));
        } else if (code === 0) {
          settle();
        } else {
          settle(new Error(errorOutput.trim() || "Audio processing failed."));
        }
      });
    });

    return await readFile(outputPath);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

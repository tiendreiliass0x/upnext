// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  maximumTrimBytes,
  previewBitrateKbps,
  previewChannels,
  previewSampleRate,
  previewSeconds,
  trimBudgetMs,
  trimToPreview,
} from "@/lib/preview-client";

function audioBuffer(seconds: number, channels = 2) {
  const length = Math.ceil(seconds * previewSampleRate);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    data[i] = Math.sin((i / previewSampleRate) * 440 * 2 * Math.PI) * 0.8;
  }
  return {
    duration: seconds,
    sampleRate: previewSampleRate,
    numberOfChannels: channels,
    length,
    getChannelData: () => data,
  };
}

/** Stand in for the Web Audio APIs jsdom does not provide. */
function installAudio(options: {
  decoded?: ReturnType<typeof audioBuffer>;
  decodeRejects?: boolean;
  decodeHangs?: boolean;
  renderSeconds?: number;
} = {}) {
  const closed = { count: 0 };
  const decoded = options.decoded ?? audioBuffer(240);
  const constructed: Array<[number, number, number]> = [];
  class FakeAudioContext {
    decodeAudioData() {
      if (options.decodeHangs) return new Promise(() => {});
      return options.decodeRejects
        ? Promise.reject(new Error("unsupported codec"))
        : Promise.resolve(decoded);
    }
    close() {
      closed.count += 1;
      return Promise.resolve();
    }
  }
  class FakeOfflineAudioContext {
    constructor(channels: number, length: number, rate: number) {
      constructed.push([channels, length, rate]);
    }
    createBufferSource() {
      return { buffer: null, connect: () => {}, start: () => {} };
    }
    startRendering() {
      return Promise.resolve(audioBuffer(options.renderSeconds ?? previewSeconds));
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
  return { closed, constructed };
}

function sourceFile(bytes: number, name = "Artist - Song.flac") {
  return new File([new Uint8Array(bytes)], name, { type: "audio/flac" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser preview trimming", () => {
  it("falls back without the Web Audio APIs", async () => {
    // jsdom has no AudioContext, which is exactly the fallback case.
    expect(await trimToPreview(sourceFile(9_000_000))).toBeNull();
  });

  it("produces a smaller mp3 and never touches the original file", async () => {
    installAudio();
    const original = sourceFile(9_000_000);

    const trimmed = await trimToPreview(original);

    expect(trimmed).not.toBeNull();
    expect(trimmed?.type).toBe("audio/mpeg");
    expect(trimmed?.name).toBe("Artist - Song.mp3");
    expect(trimmed!.size).toBeLessThan(original.size);
    // 30 s at 128 kbps is ~480 KB; allow for headers and encoder padding.
    const expected = (previewSeconds * previewBitrateKbps * 1000) / 8;
    expect(trimmed!.size).toBeGreaterThan(expected * 0.6);
    expect(trimmed!.size).toBeLessThan(expected * 1.6);
  }, 60_000);

  it("asks the renderer for exactly the preview window", async () => {
    const { constructed } = installAudio({ decoded: audioBuffer(600) });

    await trimToPreview(sourceFile(20_000_000));

    // A ten minute source must still be cut to the preview length, in the
    // server's shape: stereo at 44.1 kHz.
    expect(constructed).toEqual([
      [previewChannels, previewSeconds * previewSampleRate, previewSampleRate],
    ]);
  }, 60_000);

  it("leaves a file too large to decode safely to the server", async () => {
    const { closed } = installAudio();
    expect(await trimToPreview(sourceFile(maximumTrimBytes + 1))).toBeNull();
    // Never decoded: that is where the memory would have gone.
    expect(closed.count).toBe(0);
    expect(await trimToPreview(sourceFile(maximumTrimBytes))).not.toBeNull();
  }, 60_000);

  it("gives up and releases the context when decoding blows the time budget", async () => {
    vi.useFakeTimers();
    try {
      const { closed } = installAudio({ decodeHangs: true });
      const pending = trimToPreview(sourceFile(9_000_000));
      await vi.advanceTimersByTimeAsync(trimBudgetMs + 1);
      expect(await pending).toBeNull();
      expect(closed.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops encoding once the clock runs past the budget", async () => {
    const { closed } = installAudio();
    // Decode and render come back instantly; the wall clock then jumps past
    // the budget partway through the encode loop.
    const start = Date.now();
    let calls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      calls += 1;
      return calls > 3 ? start + trimBudgetMs + 1 : start;
    });
    const seen: number[] = [];

    const result = await trimToPreview(sourceFile(9_000_000), (fraction) =>
      seen.push(fraction),
    );

    expect(result).toBeNull();
    // It gave up early: never reached the end-of-encode progress report.
    expect(seen).not.toContain(1);
    expect(closed.count).toBe(1);
  }, 30_000);

  it("does not spend CPU on a file already at preview size", async () => {
    const { closed } = installAudio();
    // ~470 KB is already the target; re-encoding it saves nothing.
    expect(await trimToPreview(sourceFile(470_000))).toBeNull();
    // Never even opened an audio context.
    expect(closed.count).toBe(0);
  });

  it("falls back when the browser cannot decode the codec", async () => {
    installAudio({ decodeRejects: true });
    expect(await trimToPreview(sourceFile(9_000_000))).toBeNull();
  });

  it("falls back rather than uploading something larger than the original", async () => {
    // A very short clip encodes to more bytes than a tiny source file.
    installAudio({ renderSeconds: 1 });
    expect(await trimToPreview(sourceFile(120))).toBeNull();
  }, 30_000);

  it("releases the audio context even when decoding fails", async () => {
    const { closed } = installAudio({ decodeRejects: true });
    await trimToPreview(sourceFile(9_000_000));
    expect(closed.count).toBe(1);
  });
});

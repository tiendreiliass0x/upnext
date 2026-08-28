import { describe, expect, it } from "vitest";
import { sniffAudioFormat } from "@/lib/audio";

function bytes(...parts: Array<string | number[]>) {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") out.push(...Array.from(part, (c) => c.charCodeAt(0)));
    else out.push(...part);
  }
  while (out.length < 16) out.push(0);
  return new Uint8Array(out);
}

describe("sniffAudioFormat", () => {
  it("identifies the containers the booth accepts", () => {
    expect(sniffAudioFormat(bytes("ID3"))?.extension).toBe("mp3");
    expect(sniffAudioFormat(bytes([0xff, 0xfb, 0x90, 0x00]))?.extension).toBe("mp3");
    expect(sniffAudioFormat(bytes("RIFF", [0, 0, 0, 0], "WAVE"))?.contentType).toBe("audio/wav");
    expect(sniffAudioFormat(bytes("fLaC"))?.extension).toBe("flac");
    expect(sniffAudioFormat(bytes("OggS"))?.extension).toBe("ogg");
    expect(sniffAudioFormat(bytes([0, 0, 0, 0x20], "ftypM4A "))?.extension).toBe("m4a");
    expect(sniffAudioFormat(bytes("FORM", [0, 0, 0, 0], "AIFF"))?.extension).toBe("aiff");
    expect(sniffAudioFormat(bytes([0xff, 0xf1, 0x50, 0x80]))?.extension).toBe("aac");
  });

  it("rejects what is not audio, whatever the file was named", () => {
    expect(sniffAudioFormat(bytes("<!doctype html>"))).toBeNull();
    expect(sniffAudioFormat(bytes("MZ", [0x90, 0]))).toBeNull();
    expect(sniffAudioFormat(bytes("%PDF-1.7"))).toBeNull();
    expect(sniffAudioFormat(new Uint8Array(4))).toBeNull();
    // RIFF alone is also AVI and WebP; only RIFF/WAVE is audio.
    expect(sniffAudioFormat(bytes("RIFF", [0, 0, 0, 0], "AVI "))).toBeNull();
    // Reserved MPEG version bits are not a frame header.
    expect(sniffAudioFormat(bytes([0xff, 0xeb, 0x90, 0x00]))).toBeNull();
  });
});

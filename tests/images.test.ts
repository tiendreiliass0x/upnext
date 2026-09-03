import { describe, expect, it } from "vitest";
import { sniffImageFormat } from "@/lib/images";

function bytes(...values: number[]) {
  const padded = [...values];
  while (padded.length < 16) padded.push(0);
  return new Uint8Array(padded);
}

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));

describe("sniffImageFormat", () => {
  it("names the formats a profile picture may be in", () => {
    expect(sniffImageFormat(bytes(0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a))).toEqual(
      { contentType: "image/png", extension: "png" },
    );
    expect(sniffImageFormat(bytes(0xff, 0xd8, 0xff, 0xe0))).toEqual({
      contentType: "image/jpeg",
      extension: "jpg",
    });
    expect(
      sniffImageFormat(bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"))),
    ).toEqual({ contentType: "image/webp", extension: "webp" });
    expect(sniffImageFormat(bytes(...ascii("GIF89a")))).toEqual({
      contentType: "image/gif",
      extension: "gif",
    });
  });

  it("refuses an SVG, which is a document that can carry script", () => {
    expect(sniffImageFormat(bytes(...ascii("<svg xmlns=")))).toBeNull();
    expect(sniffImageFormat(bytes(...ascii("<!DOCTYPE html>")))).toBeNull();
  });

  it("refuses audio, an executable and anything too short to tell", () => {
    // A WAV is RIFF too; only the second tag separates it from a WebP.
    expect(
      sniffImageFormat(bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE"))),
    ).toBeNull();
    expect(sniffImageFormat(bytes(0x7f, ...ascii("ELF")))).toBeNull();
    expect(sniffImageFormat(new Uint8Array([0x89, 0x50, 0x4e]))).toBeNull();
  });
});

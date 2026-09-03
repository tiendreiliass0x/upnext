import { describe, expect, it } from "vitest";
import {
  imageSizeError,
  maximumAvatarSide,
  readImageHeader,
  sniffImageFormat,
} from "@/lib/images";

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

function png(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 0x0d, ...ascii("IHDR")], 8);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function gif(width: number, height: number) {
  const bytes = new Uint8Array(16);
  bytes.set(ascii("GIF89a"));
  new DataView(bytes.buffer).setUint16(6, width, true);
  new DataView(bytes.buffer).setUint16(8, height, true);
  return bytes;
}

function webpExtended(width: number, height: number) {
  const bytes = new Uint8Array(32);
  bytes.set(ascii("RIFF"));
  bytes.set(ascii("WEBP"), 8);
  bytes.set(ascii("VP8X"), 12);
  const view = new DataView(bytes.buffer);
  // Canvas size is stored minus one, three bytes each, little-endian.
  view.setUint16(24, (width - 1) & 0xffff, true);
  bytes[26] = ((width - 1) >> 16) & 0xff;
  view.setUint16(27, (height - 1) & 0xffff, true);
  bytes[29] = ((height - 1) >> 16) & 0xff;
  return bytes;
}

/** A JPEG whose frame header sits behind `padding` bytes of metadata. */
function jpeg(width: number, height: number, padding = 0) {
  const head = [0xff, 0xd8];
  if (padding > 0) {
    // An APP1 segment standing in for EXIF.
    head.push(0xff, 0xe1, ((padding + 2) >> 8) & 0xff, (padding + 2) & 0xff);
    for (let i = 0; i < padding; i += 1) head.push(0);
  }
  head.push(
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
  );
  // Trailing scan data, so the fixture is a plausible length rather than the
  // eleven bytes a bare frame header would be.
  while (head.length < 32) head.push(0);
  return new Uint8Array(head);
}

describe("readImageHeader", () => {
  it("reads the pixel size out of each format's header", () => {
    expect(readImageHeader(png(640, 480))).toMatchObject({
      extension: "png",
      width: 640,
      height: 480,
    });
    expect(readImageHeader(gif(120, 90))).toMatchObject({
      extension: "gif",
      width: 120,
      height: 90,
    });
    expect(readImageHeader(webpExtended(1024, 768))).toMatchObject({
      extension: "webp",
      width: 1024,
      height: 768,
    });
    expect(readImageHeader(jpeg(300, 200))).toMatchObject({
      extension: "jpg",
      width: 300,
      height: 200,
    });
  });

  it("walks past a camera's metadata to find a JPEG's frame header", () => {
    expect(readImageHeader(jpeg(4032, 3024, 40_000))).toMatchObject({
      width: 4032,
      height: 3024,
    });
  });

  it("refuses a file whose size cannot be established", () => {
    // The right magic bytes, but the chunk that states the size is not there.
    const truncated = png(10, 10).slice(0, 14);
    expect(sniffImageFormat(truncated)).not.toBeNull();
    expect(readImageHeader(truncated)).toBeNull();
    // A JPEG that reaches its scan data without ever declaring a frame.
    const noFrame = new Uint8Array(32);
    noFrame.set([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]);
    expect(sniffImageFormat(noFrame)).not.toBeNull();
    expect(readImageHeader(noFrame)).toBeNull();
  });
});

describe("imageSizeError", () => {
  it("passes a picture a phone actually takes", () => {
    expect(imageSizeError({ width: 4032, height: 3024 })).toBeNull();
    expect(imageSizeError({ width: 512, height: 512 })).toBeNull();
  });

  it("refuses the shapes that are cheap to send and ruinous to draw", () => {
    // A solid 10000x10000 PNG compresses to well under the byte ceiling and
    // asks every guest's browser for hundreds of megabytes to decode.
    expect(imageSizeError({ width: 10_000, height: 10_000 })).toMatch(/pixels on a side/);
    // Long and thin passes the pixel budget but not the side limit.
    expect(imageSizeError({ width: maximumAvatarSide + 1, height: 1 })).not.toBeNull();
    expect(imageSizeError({ width: maximumAvatarSide, height: maximumAvatarSide })).toBeNull();
  });
});

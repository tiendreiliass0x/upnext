/**
 * A profile picture is stored as the file the person chose, not re-encoded:
 * there is no image library on the server, and a 2 MB ceiling makes one hard
 * to justify. So the container is identified from its leading bytes, exactly
 * as uploaded audio is (src/lib/audio.ts) — a cheap sanity check that keeps
 * HTML pages, SVGs and executables out of the bucket rather than a decoder.
 *
 * SVG is deliberately absent. It is a document that can carry script, and the
 * avatar route hands its bytes back under this app's own origin, so an SVG
 * avatar would be a stored cross-site scripting hole rather than a picture.
 */

/**
 * A picture shown at 30 pixels across does not need more than this, and the
 * route buffers the body in memory. Nothing re-encodes it, so this ceiling is
 * the only thing between a phone camera's original and the bucket. It lives
 * here rather than in the route so the form can refuse an oversized file
 * before spending a minute of venue wifi sending it.
 */
export const maximumAvatarBytes = 2 * 1024 * 1024;

/**
 * Compressed bytes do not bound what a picture costs to *look at*. A solid
 * 10000×10000 PNG compresses to a few hundred kilobytes and still asks every
 * guest's phone for ~400 MB of RGBA to draw one 30-pixel face — a picture
 * that is small to store, small to send and ruinous to decode.
 *
 * So dimensions are read out of the header and bounded too. The long side of
 * a current phone camera is around 4032, which fits: this is the backstop for
 * a client that could not shrink its own upload, not the main control. The
 * form downscales before sending (see prepareAvatarFile in Dashboard.tsx), so
 * a picture that reaches these limits is one that arrived some other way.
 */
export const maximumAvatarSide = 4096;
export const maximumAvatarPixels = 4096 * 4096;

/**
 * How much of the file the header scan is given. PNG, GIF and WebP declare
 * their size in the first few dozen bytes; a JPEG's frame header sits after
 * however much EXIF and colour-profile metadata the camera wrote, which is
 * comfortably inside this for anything a phone produces.
 */
export const imageHeaderBytes = 256 * 1024;

export type ImageFormat = {
  contentType: string;
  extension: string;
};

export type ImageHeader = ImageFormat & {
  width: number;
  height: number;
};

function startsWith(bytes: Uint8Array, offset: number, ascii: string) {
  if (bytes.length < offset + ascii.length) return false;
  for (let index = 0; index < ascii.length; index += 1) {
    if (bytes[offset + index] !== ascii.charCodeAt(index)) return false;
  }
  return true;
}

function big16(bytes: Uint8Array, at: number) {
  return (bytes[at] << 8) | bytes[at + 1];
}

function big32(bytes: Uint8Array, at: number) {
  return (
    ((bytes[at] << 24) >>> 0) +
    (bytes[at + 1] << 16) +
    (bytes[at + 2] << 8) +
    bytes[at + 3]
  );
}

function little16(bytes: Uint8Array, at: number) {
  return bytes[at] | (bytes[at + 1] << 8);
}

function little24(bytes: Uint8Array, at: number) {
  return bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
}

export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length < 12) return null;
  if (
    bytes[0] === 0x89 &&
    startsWith(bytes, 1, "PNG") &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a
  ) {
    return { contentType: "image/png", extension: "png" };
  }
  // JPEG: SOI followed by any marker.
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (startsWith(bytes, 0, "RIFF") && startsWith(bytes, 8, "WEBP")) {
    return { contentType: "image/webp", extension: "webp" };
  }
  if (startsWith(bytes, 0, "GIF87a") || startsWith(bytes, 0, "GIF89a")) {
    return { contentType: "image/gif", extension: "gif" };
  }
  return null;
}

/** The pixel size a PNG declares in its IHDR, which is always the first chunk. */
function pngSize(bytes: Uint8Array) {
  if (bytes.length < 24 || !startsWith(bytes, 12, "IHDR")) return null;
  return { width: big32(bytes, 16), height: big32(bytes, 20) };
}

function gifSize(bytes: Uint8Array) {
  if (bytes.length < 10) return null;
  return { width: little16(bytes, 6), height: little16(bytes, 8) };
}

/** WebP comes in three framings and each states its size differently. */
function webpSize(bytes: Uint8Array) {
  if (startsWith(bytes, 12, "VP8X")) {
    // Extended: the canvas size is stored minus one, three bytes each.
    if (bytes.length < 30) return null;
    return {
      width: little24(bytes, 24) + 1,
      height: little24(bytes, 27) + 1,
    };
  }
  if (startsWith(bytes, 12, "VP8L")) {
    // Lossless: 14 bits of width then 14 of height, both minus one, packed
    // little-endian across four bytes after the 0x2f signature byte.
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const packed =
      bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >>> 14) & 0x3fff) + 1,
    };
  }
  if (startsWith(bytes, 12, "VP8 ")) {
    // Lossy: a keyframe's start code, then 14 bits of each dimension.
    if (bytes.length < 30) return null;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return null;
    }
    return {
      width: little16(bytes, 26) & 0x3fff,
      height: little16(bytes, 28) & 0x3fff,
    };
  }
  return null;
}

/**
 * A JPEG states its size in a start-of-frame segment, which sits after any
 * number of metadata segments of any length, so the marker chain has to be
 * walked to find it.
 */
function jpegSize(bytes: Uint8Array) {
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    let marker = bytes[at + 1];
    // Any run of 0xff is padding before the real marker byte.
    while (marker === 0xff && at + 2 < bytes.length) {
      at += 1;
      marker = bytes[at + 1];
    }
    // Standalone markers carry no length: restart, SOI, EOI, TEM.
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      at += 2;
      continue;
    }
    // Entropy-coded data starts here and the frame header is behind us.
    if (marker === 0xda) return null;
    const length = big16(bytes, at + 2);
    if (length < 2) return null;
    // SOF0..SOF15 hold the frame size; DHT, JPG and DAC share the range and
    // do not.
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isStartOfFrame) {
      if (at + 9 > bytes.length) return null;
      return { height: big16(bytes, at + 5), width: big16(bytes, at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

/**
 * The format and pixel size of a picture, or null when the leading bytes are
 * not one this app stores or do not carry a size it can read. A file whose
 * dimensions cannot be established is refused rather than trusted: the whole
 * point of reading them is that the byte count does not bound the cost of
 * drawing the thing.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  const format = sniffImageFormat(bytes);
  if (!format) return null;
  const size =
    format.extension === "png"
      ? pngSize(bytes)
      : format.extension === "gif"
        ? gifSize(bytes)
        : format.extension === "webp"
          ? webpSize(bytes)
          : jpegSize(bytes);
  if (!size) return null;
  const { width, height } = size;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { ...format, width, height };
}

/** Why a picture of this size is refused, or null when it is fine. */
export function imageSizeError(header: {
  width: number;
  height: number;
}): string | null {
  if (
    header.width > maximumAvatarSide ||
    header.height > maximumAvatarSide ||
    header.width * header.height > maximumAvatarPixels
  ) {
    return `Profile pictures must be at most ${maximumAvatarSide} pixels on a side.`;
  }
  return null;
}

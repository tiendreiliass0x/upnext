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

export type ImageFormat = {
  contentType: string;
  extension: string;
};

function startsWith(bytes: Uint8Array, offset: number, ascii: string) {
  if (bytes.length < offset + ascii.length) return false;
  for (let index = 0; index < ascii.length; index += 1) {
    if (bytes[offset + index] !== ascii.charCodeAt(index)) return false;
  }
  return true;
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

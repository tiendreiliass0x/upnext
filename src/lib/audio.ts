/**
 * Uploads are stored as the DJ's original file, not re-encoded. ffmpeg used
 * to double as the format check (a file it could not decode was rejected), so
 * the container is now identified from its leading bytes instead. This is a
 * cheap sanity check that keeps HTML pages and executables out of the bucket;
 * it is not a decoder, and a truncated or corrupt file still gets through and
 * fails at play time.
 */
export type AudioFormat = {
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

export function sniffAudioFormat(bytes: Uint8Array): AudioFormat | null {
  if (bytes.length < 12) return null;
  if (startsWith(bytes, 0, "ID3")) return { contentType: "audio/mpeg", extension: "mp3" };
  // MPEG audio frame sync: 11 set bits, then a version that is not reserved.
  if (bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2 && (bytes[1] & 0x18) !== 0x08) {
    return { contentType: "audio/mpeg", extension: "mp3" };
  }
  if (startsWith(bytes, 0, "RIFF") && startsWith(bytes, 8, "WAVE")) {
    return { contentType: "audio/wav", extension: "wav" };
  }
  if (startsWith(bytes, 0, "fLaC")) return { contentType: "audio/flac", extension: "flac" };
  if (startsWith(bytes, 0, "OggS")) return { contentType: "audio/ogg", extension: "ogg" };
  if (startsWith(bytes, 4, "ftyp")) return { contentType: "audio/mp4", extension: "m4a" };
  if (startsWith(bytes, 0, "FORM") && (startsWith(bytes, 8, "AIFF") || startsWith(bytes, 8, "AIFC"))) {
    return { contentType: "audio/aiff", extension: "aiff" };
  }
  // ADTS AAC: sync word 0xFFF with layer bits zero.
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
    return { contentType: "audio/aac", extension: "aac" };
  }
  return null;
}

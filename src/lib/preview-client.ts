import { Mp3Encoder } from "@breezystack/lamejs";

// Kept identical to the server's FFmpeg settings so a browser-made preview and
// a server-made one are interchangeable. 128 kbps stereo is deliberate: these
// clips are meant to be playable out loud, not just auditioned on a handset.
export const previewSeconds = 30;
export const previewBitrateKbps = 128;
export const previewSampleRate = 44100;
export const previewChannels = 2;

const samplesPerFrame = 1152;
// Yield to the event loop roughly every quarter second of audio so a long
// encode does not freeze the setup screen.
const framesPerSlice = 48;

type AudioContextConstructor = typeof AudioContext;

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  const scope = window as typeof window & {
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** Whether this browser can trim at all. Callers fall back to the server. */
export function canTrimInBrowser() {
  return (
    getAudioContextConstructor() !== null &&
    typeof OfflineAudioContext !== "undefined"
  );
}

function toInt16(samples: Float32Array) {
  const out = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    // Clamp before scaling: decoded audio can exceed +/-1 and wrapping a
    // sample turns a loud passage into a click.
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    out[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

async function encodeMp3(
  buffer: AudioBuffer,
  onProgress?: (fraction: number) => void,
) {
  const left = toInt16(buffer.getChannelData(0));
  const right = toInt16(
    buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0),
  );
  const encoder = new Mp3Encoder(
    previewChannels,
    buffer.sampleRate,
    previewBitrateKbps,
  );

  const chunks: Uint8Array[] = [];
  let sliceCount = 0;
  for (let offset = 0; offset < left.length; offset += samplesPerFrame) {
    const encoded = encoder.encodeBuffer(
      left.subarray(offset, offset + samplesPerFrame),
      right.subarray(offset, offset + samplesPerFrame),
    );
    if (encoded.length > 0) chunks.push(encoded);

    sliceCount += 1;
    if (sliceCount % framesPerSlice === 0) {
      onProgress?.(offset / left.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(tail);
  onProgress?.(1);
  return chunks;
}

/**
 * Trim an audio file to a preview in the browser, so the upload carries roughly
 * half a megabyte instead of the whole track.
 *
 * This is a bandwidth and memory optimisation, never a trust boundary: the
 * server still re-encodes with a hard 30 second limit, because a client is free
 * to send whatever it likes.
 *
 * Returns null whenever trimming is not possible or not worthwhile, and the
 * caller uploads the original file instead.
 */
export async function trimToPreview(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<File | null> {
  // Encoding costs seconds of phone CPU. A file already at or below preview
  // size has no bandwidth left to save, so spending that is pure waste.
  const previewBytes = (previewSeconds * previewBitrateKbps * 1000) / 8;
  if (file.size <= previewBytes * 1.25) return null;

  const AudioContextCtor = getAudioContextConstructor();
  if (!AudioContextCtor || typeof OfflineAudioContext === "undefined") return null;

  let context: AudioContext | null = null;
  try {
    context = new AudioContextCtor();
    const decoded = await context.decodeAudioData(await file.arrayBuffer());

    const seconds = Math.min(decoded.duration, previewSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;

    // One offline render handles the trim, the resample and the mix to stereo,
    // so the encoder always sees the shape the server would have produced.
    const offline = new OfflineAudioContext(
      previewChannels,
      Math.ceil(seconds * previewSampleRate),
      previewSampleRate,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();

    const chunks = await encodeMp3(rendered, onProgress);
    const blob = new Blob(chunks as BlobPart[], { type: "audio/mpeg" });

    // A file that did not get smaller is not worth swapping in; sending the
    // original keeps the server's result at least as good.
    if (blob.size === 0 || blob.size >= file.size) return null;

    const name = file.name.replace(/\.[^.]+$/, "") || "preview";
    return new File([blob], `${name}.mp3`, { type: "audio/mpeg" });
  } catch {
    // Unsupported codec, a decode failure, or no permission for an
    // AudioContext. The server path still works.
    return null;
  } finally {
    await context?.close().catch(() => undefined);
  }
}

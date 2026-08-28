import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { sniffAudioFormat } from "@/lib/audio";
import { getAccountFromRequest } from "@/lib/auth";
import { deletePreview, uploadPreview } from "@/lib/r2";
import { rateLimitedResponse, takeRateLimit } from "@/lib/rate-limit";
import {
  getAccountStorageBytes,
  getAudioUploadByRequest,
  registerAudioUpload,
} from "@/lib/sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Full songs are stored as uploaded. 60 MB covers a long lossless track; the
// route buffers the body in memory, so this bound and the one-job-per-account
// gate below are what keep a burst of uploads from exhausting a small VPS.
const maximumUploadSize = 60 * 1024 * 1024;

// Storage is the cost that scales: a library track pins its upload for good,
// and accounts are self-registered, so without a per-account ceiling one
// person could fill the bucket. 1 GB is roughly eighty MP3s or twenty long
// WAVs — a working catalogue for one DJ, not a hosting service.
export const accountStorageQuota =
  Math.max(1, Number(process.env.UPLOAD_QUOTA_MB) || 1024) * 1024 * 1024;
// Uploads per account per hour: generous for a set, far too few for a script.
const uploadRateLimit = { limit: 60, windowMs: 60 * 60 * 1000 };
type UploadRegistry = typeof globalThis & {
  djBoothAudioJobs?: Set<string>;
};
const uploadRegistry = globalThis as UploadRegistry;
const activeAudioJobs =
  uploadRegistry.djBoothAudioJobs ?? new Set<string>();
uploadRegistry.djBoothAudioJobs = activeAudioJobs;

export async function POST(request: Request) {
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json({ error: "Sign in to upload music." }, { status: 401 });
  }
  const rawRequestId = request.headers.get("x-upnext-upload-id")?.trim() ?? "";
  const requestId = rawRequestId.length <= 100 ? rawRequestId : "";
  if (requestId) {
    const existingPreviewKey = getAudioUploadByRequest(account.id, requestId);
    if (existingPreviewKey) {
      return NextResponse.json({ previewKey: existingPreviewKey });
    }
  }
  const contentLengthHeader = request.headers.get("content-length");
  if (!contentLengthHeader) {
    return NextResponse.json(
      { error: "A bounded upload size is required." },
      { status: 411 },
    );
  }
  const contentLength = Number(contentLengthHeader);
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return NextResponse.json(
      { error: "The upload size is not valid." },
      { status: 400 },
    );
  }
  if (contentLength > maximumUploadSize + 1024 * 1024) {
    return NextResponse.json(
      { error: "Audio files must be smaller than 60 MB." },
      { status: 413 },
    );
  }
  const retryAfter = takeRateLimit("uploads", account.id, uploadRateLimit);
  if (retryAfter !== null) return rateLimitedResponse(retryAfter);
  if (activeAudioJobs.has(account.id) || activeAudioJobs.size >= 2) {
    return NextResponse.json(
      { error: "Uploads are busy. Try again in a moment." },
      { status: 429 },
    );
  }

  let uploadedObjectKey = "";
  activeAudioJobs.add(account.id);
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Choose an audio file." }, { status: 400 });
    }
    if (file.size === 0 || file.size > maximumUploadSize) {
      return NextResponse.json(
        { error: "Audio files must be smaller than 60 MB." },
        { status: 413 },
      );
    }
    if (
      !file.type.startsWith("audio/") &&
      !/\.(mp3|wav|m4a|aac|flac|ogg|aiff?|opus)$/i.test(file.name)
    ) {
      return NextResponse.json(
        { error: "That file is not a supported audio format." },
        { status: 415 },
      );
    }

    // Sixteen bytes decide the format; the body itself streams to R2 rather
    // than being copied into a second 60 MB buffer next to the one the
    // request parser already holds.
    const format = sniffAudioFormat(
      new Uint8Array(await file.slice(0, 16).arrayBuffer()),
    );
    if (!format) {
      return NextResponse.json(
        { error: "That file is not a supported audio format." },
        { status: 415 },
      );
    }
    const usedBytes = getAccountStorageBytes(account.id);
    if (usedBytes + file.size > accountStorageQuota) {
      const quotaMb = Math.round(accountStorageQuota / (1024 * 1024));
      return NextResponse.json(
        {
          error: `Your storage is full (${quotaMb} MB). Remove songs from your libraries or end old rooms to free space.`,
        },
        { status: 507 },
      );
    }
    uploadedObjectKey = `audio/${account.id}/${crypto.randomUUID()}.${format.extension}`;
    await uploadPreview(
      uploadedObjectKey,
      Readable.fromWeb(file.stream() as import("node:stream/web").ReadableStream),
      format.contentType,
      { contentLength: file.size, signal: request.signal },
    );
    registerAudioUpload({
      objectKey: uploadedObjectKey,
      accountId: account.id,
      originalName: file.name.slice(0, 255),
      requestId: requestId || null,
      sizeBytes: file.size,
    });

    return NextResponse.json({ previewKey: uploadedObjectKey });
  } catch (error) {
    console.error(
      "Audio upload failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    if (uploadedObjectKey) {
      await deletePreview(uploadedObjectKey).catch(() => undefined);
    }
    const message =
      error instanceof Error && error.message === "R2 credentials are incomplete."
        ? error.message
        : "The audio could not be stored.";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    activeAudioJobs.delete(account.id);
  }
}

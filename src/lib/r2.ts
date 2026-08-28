import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type R2Registry = typeof globalThis & {
  djBoothR2Client?: S3Client;
};

const registry = globalThis as R2Registry;

function getR2Configuration() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET || "dj-booth";
  const endpoint =
    process.env.R2_ENDPOINT ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");

  if (!accessKeyId || !secretAccessKey || !endpoint) {
    throw new Error("R2 credentials are incomplete.");
  }

  return { accessKeyId, secretAccessKey, bucket, endpoint };
}

function getR2Client() {
  if (registry.djBoothR2Client) return registry.djBoothR2Client;
  const config = getR2Configuration();
  const client = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  registry.djBoothR2Client = client;
  return client;
}

export async function uploadPreview(
  objectKey: string,
  body: Buffer | Readable,
  contentType = "audio/mpeg",
  options: { contentLength?: number; signal?: AbortSignal } = {},
) {
  const { bucket } = getR2Configuration();
  await getR2Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
      ContentLength: options.contentLength,
      CacheControl: "private, max-age=31536000, immutable",
    }),
    { abortSignal: options.signal },
  );
}

export async function deletePreview(objectKey: string) {
  const { bucket } = getR2Configuration();
  await getR2Client().send(
    new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }),
  );
}

// Cleanup can retire thousands of previews at once, so keys go out in batches
// of 1000 (the S3 maximum). A key is reported deleted only when the service did
// not name it in Errors, which keeps its database row in place for the next run
// instead of orphaning the object.
export async function deletePreviews(objectKeys: string[]) {
  const deleted: string[] = [];
  const failed: string[] = [];
  if (objectKeys.length === 0) return { deleted, failed };

  const { bucket } = getR2Configuration();
  const client = getR2Client();

  for (let index = 0; index < objectKeys.length; index += 1000) {
    const batch = objectKeys.slice(index, index + 1000);
    try {
      const response = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })) },
        }),
      );
      const rejected = new Set((response.Errors ?? []).map((item) => item.Key));
      batch.forEach((key) => (rejected.has(key) ? failed : deleted).push(key));
    } catch {
      // A batch that never reached R2 is retried on the next run.
      failed.push(...batch);
    }
  }

  return { deleted, failed };
}

// The browser streams a song with Range requests against this one URL for as
// long as it plays, so the signature has to outlive the longest song plus a
// pause, not just the first byte — two minutes would cut a full track off
// partway through. It is also the window in which a guest can pass the link
// on, so it is as short as playback allows rather than as long as convenient.
export const signedReadSeconds = 15 * 60;

export async function getPreviewUrl(objectKey: string) {
  const { bucket } = getR2Configuration();
  return getSignedUrl(
    getR2Client(),
    new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
    { expiresIn: signedReadSeconds },
  );
}

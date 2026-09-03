import { NextResponse } from "next/server";
import { setAccountAvatar, toPublicAccount } from "@/lib/accounts";
import { getAccountFromRequest } from "@/lib/auth";
import { maximumAvatarBytes, sniffImageFormat } from "@/lib/images";
import { avatarObjectKey } from "@/lib/profile";
import { deletePreview, uploadPreview } from "@/lib/r2";
import { rateLimitedResponse, takeRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// One account holds one picture, so a person changing their mind repeatedly
// is still only ever storing one object. This bounds the traffic, not the
// storage, which is why it is generous.
const avatarRateLimit = { limit: 20, windowMs: 60 * 60 * 1000 };

/** Best effort: an object left behind costs a byte, a thrown error costs the save. */
async function forget(objectKey: string | null) {
  if (!objectKey) return;
  await deletePreview(objectKey).catch(() => undefined);
}

export async function POST(request: Request) {
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json(
      { error: "Sign in to change your picture." },
      { status: 401 },
    );
  }

  // A declared size is a precondition, exactly as it is for audio: the body is
  // buffered whole by formData() below, so without one a chunked request would
  // reach that call with nothing bounding it but Caddy's 65 MB cap. An absent
  // header used to pass this check silently, since Number(null) is 0.
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
  // Twice the ceiling, because the declared length covers the multipart
  // envelope around the file as well as the file itself.
  if (contentLength > maximumAvatarBytes * 2) {
    return NextResponse.json(
      { error: "Profile pictures must be smaller than 2 MB." },
      { status: 413 },
    );
  }
  const retryAfter = takeRateLimit("avatars", account.id, avatarRateLimit);
  if (retryAfter !== null) return rateLimitedResponse(retryAfter);

  let uploadedObjectKey = "";
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Choose an image file." },
        { status: 400 },
      );
    }
    if (file.size === 0 || file.size > maximumAvatarBytes) {
      return NextResponse.json(
        { error: "Profile pictures must be smaller than 2 MB." },
        { status: 413 },
      );
    }

    // The bytes decide the format, not the name or the type the browser
    // claimed: this is what keeps an SVG or an HTML page out of a bucket
    // whose objects are served back under a URL of ours.
    const format = sniffImageFormat(
      new Uint8Array(await file.slice(0, 16).arrayBuffer()),
    );
    if (!format) {
      return NextResponse.json(
        { error: "Use a PNG, JPEG, WebP or GIF image." },
        { status: 415 },
      );
    }

    uploadedObjectKey = avatarObjectKey(format.extension);
    await uploadPreview(
      uploadedObjectKey,
      Buffer.from(await file.arrayBuffer()),
      format.contentType,
    );
    const { account: updated, replacedKey } = setAccountAvatar(
      account,
      uploadedObjectKey,
    );
    // Only once the new key is committed: a failure before this point leaves
    // the old picture in place, which is the right way round to fail.
    await forget(replacedKey);
    return NextResponse.json({ account: toPublicAccount(updated) });
  } catch (error) {
    console.error(
      "Avatar upload failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    await forget(uploadedObjectKey || null);
    const message =
      error instanceof Error && error.message === "R2 credentials are incomplete."
        ? error.message
        : "Your picture could not be saved.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json(
      { error: "Sign in to change your picture." },
      { status: 401 },
    );
  }

  const { account: updated, replacedKey } = setAccountAvatar(account, null);
  await forget(replacedKey);
  return NextResponse.json({ account: toPublicAccount(updated) });
}

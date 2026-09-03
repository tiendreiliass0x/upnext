import { NextResponse } from "next/server";
import { avatarKeyForName } from "@/lib/profile";
import { getPreviewUrl, signedReadSeconds } from "@/lib/r2";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// A cached redirect must never outlive the signature it points at, so this
// sits comfortably inside the signing window rather than up against it.
const redirectMaxAge = Math.floor(signedReadSeconds / 2);

/**
 * A profile picture, addressed by its object name alone.
 *
 * Deliberately unauthenticated, like the track preview route: a face appears
 * beside every vote in a room and the crowd is anonymous, so there is nobody
 * to authenticate. The name is a long random one nothing else discloses, and
 * it changes whenever the picture does, which is what a caller has to know to
 * fetch one. No account ID appears here or in the payload that carries it.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ name: string }> },
) {
  const { name } = await context.params;
  const objectKey = avatarKeyForName(name);
  if (!objectKey) {
    return NextResponse.json(
      { error: "That profile picture was not found." },
      { status: 404 },
    );
  }

  try {
    return NextResponse.redirect(await getPreviewUrl(objectKey), {
      status: 307,
      headers: { "Cache-Control": `private, max-age=${redirectMaxAge}` },
    });
  } catch {
    return NextResponse.json(
      { error: "The profile picture could not be loaded." },
      { status: 502 },
    );
  }
}

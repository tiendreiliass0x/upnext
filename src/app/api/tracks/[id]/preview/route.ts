import { NextResponse } from "next/server";
import { resolveProviderPreviewUrl } from "@/lib/provider-preview";
import { getPreviewUrl } from "@/lib/r2";
import { getTrackPreviewKey } from "@/lib/sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * One URL for both kinds of row. An uploaded song is presigned out of R2; an
 * imported one is resolved from the service it came from. The client cannot
 * tell the difference, which is why importing a playlist needed no change to
 * the pre-listen button, the guest dock or the /play console.
 */
async function playableUrl(trackId: string) {
  const objectKey = getTrackPreviewKey(trackId);
  if (objectKey) return getPreviewUrl(objectKey);
  return resolveProviderPreviewUrl(trackId);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  try {
    const previewUrl = await playableUrl(id);
    if (!previewUrl) {
      return NextResponse.json(
        { error: "This preview is no longer available." },
        { status: 404 },
      );
    }
    // A pre-listen sets the URL on an element it already holds, so it asks
    // for the URL as JSON rather than following a redirect.
    if (new URL(request.url).searchParams.get("as") === "json") {
      return NextResponse.json(
        { url: previewUrl },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // Deliberately unauthenticated: guests are anonymous, and being a track
    // in a live room is the whole gate (getTrackPreviewKey and
    // getTrackProviderRef both enforce it). The URL is short-lived either
    // way; never let a cache hand it to the next caller.
    return NextResponse.redirect(previewUrl, {
      status: 307,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "The preview could not be loaded." },
      { status: 502 },
    );
  }
}

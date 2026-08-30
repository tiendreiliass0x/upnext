import { NextResponse } from "next/server";
import { getPreviewUrl } from "@/lib/r2";
import { getTrackPreviewKey } from "@/lib/sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const objectKey = getTrackPreviewKey(id);
  if (!objectKey) {
    return NextResponse.json(
      { error: "This preview is no longer available." },
      { status: 404 },
    );
  }

  try {
    const previewUrl = await getPreviewUrl(objectKey);
    // A pre-listen sets the URL on an element it already holds, so it asks
    // for the URL as JSON rather than following a redirect.
    if (new URL(request.url).searchParams.get("as") === "json") {
      return NextResponse.json(
        { url: previewUrl },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // Deliberately unauthenticated: guests are anonymous, and being a track
    // in a live room is the whole gate (getTrackPreviewKey). The signed URL
    // is per-request and short-lived; never let a cache hand it to the next
    // caller.
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

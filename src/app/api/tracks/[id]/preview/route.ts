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
  // The host key travels in a header, never the query string, so it stays
  // out of access logs and browser history.
  const objectKey = getTrackPreviewKey(id, {
    hostKey: request.headers.get("x-upnext-host-key"),
  });
  if (!objectKey) {
    return NextResponse.json(
      { error: "This preview is no longer available." },
      { status: 404 },
    );
  }

  try {
    const previewUrl = await getPreviewUrl(objectKey);
    // An <audio src> cannot carry the host-key header, so the DJ's pre-listen
    // asks for the signed URL as JSON and sets it on the element itself.
    if (new URL(request.url).searchParams.get("as") === "json") {
      return NextResponse.json(
        { url: previewUrl },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // Deliberately unauthenticated for guests: they are anonymous, and the
    // song being on air in a live room is the gate (getTrackPreviewKey). The
    // signed URL is per-request and short-lived; never let a cache hand it
    // to the next caller.
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

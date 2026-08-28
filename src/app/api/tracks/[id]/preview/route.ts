import { NextResponse } from "next/server";
import { getPreviewUrl } from "@/lib/r2";
import { getTrackPreviewKey } from "@/lib/sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
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
    // Deliberately unauthenticated: guests are anonymous, and the room being
    // live and unexpired is the gate (getTrackPreviewKey). The signed URL is
    // per-request and short-lived; never let a cache hand it to the next
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

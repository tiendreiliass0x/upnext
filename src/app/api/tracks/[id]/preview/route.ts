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
    return NextResponse.redirect(previewUrl, 307);
  } catch {
    return NextResponse.json(
      { error: "The preview could not be loaded." },
      { status: 502 },
    );
  }
}

import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin";
import { getAccountFromRequest } from "@/lib/auth";
import { getLibraryTrackPreviewKey } from "@/lib/libraries";
import { getPreviewUrl } from "@/lib/r2";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  // Unlike a room preview, the catalogue is not public: only signed-in DJs and
  // the admin can audition it.
  if (!getAccountFromRequest(request) && !isAdminRequest(request)) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const { id } = await context.params;
  const objectKey = getLibraryTrackPreviewKey(id);
  if (!objectKey) {
    return NextResponse.json(
      { error: "This preview is no longer available." },
      { status: 404 },
    );
  }

  try {
    return NextResponse.redirect(await getPreviewUrl(objectKey), 307);
  } catch {
    return NextResponse.json(
      { error: "The preview could not be loaded." },
      { status: 502 },
    );
  }
}

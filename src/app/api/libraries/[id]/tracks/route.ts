import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin";
import { getAccountFromRequest } from "@/lib/auth";
import { addLibraryTrack, listLibraryTracks } from "@/lib/libraries";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!getAccountFromRequest(request) && !isAdminRequest(request)) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const { id } = await context.params;
  const query = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json({
    tracks: listLibraryTracks({ libraryId: id, query: query.slice(0, 100) }),
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  // Admins curate, and DJs contribute what they have already uploaded, so
  // either credential is enough to add. Removal stays admin-only.
  const account = getAccountFromRequest(request);
  const admin = isAdminRequest(request);
  if (!account && !admin) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  try {
    const { id } = await context.params;
    const body = (await request.json()) as {
      title?: unknown;
      artist?: unknown;
      previewKey?: unknown;
    };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const artist = typeof body.artist === "string" ? body.artist.trim() : "";
    if (!title) {
      return NextResponse.json({ error: "A title is required." }, { status: 400 });
    }

    const result = addLibraryTrack({
      libraryId: id,
      title: title.slice(0, 120),
      artist: artist.slice(0, 120) || "Unknown artist",
      previewKey:
        typeof body.previewKey === "string" ? body.previewKey.slice(0, 500) : null,
      contributedBy: account?.id ?? null,
    });

    if (result === null) {
      return NextResponse.json({ error: "No such library." }, { status: 404 });
    }
    if (result === "unknown_preview") {
      return NextResponse.json(
        { error: "That preview does not exist. Upload the audio first." },
        { status: 400 },
      );
    }
    return NextResponse.json({ track: result }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "The song could not be added." },
      { status: 500 },
    );
  }
}

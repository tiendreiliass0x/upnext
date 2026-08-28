import { NextResponse } from "next/server";
import { getAccountFromRequest } from "@/lib/auth";
import { addTrackToPlaylist } from "@/lib/playlists";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  try {
    const { id } = await context.params;
    const body = (await request.json()) as { trackId?: unknown };
    if (typeof body.trackId !== "string" || !body.trackId) {
      return NextResponse.json({ error: "A track is required." }, { status: 400 });
    }

    const result = addTrackToPlaylist({
      playlistId: id,
      accountId: account.id,
      libraryTrackId: body.trackId,
    });

    if (result === "no_playlist") {
      return NextResponse.json({ error: "No such playlist." }, { status: 404 });
    }
    if (result === "no_track") {
      return NextResponse.json(
        { error: "That song is no longer in the catalogue." },
        { status: 404 },
      );
    }
    // Adding twice is the same outcome as adding once, so it is not an error.
    return NextResponse.json(
      { added: result === "added" },
      { status: result === "added" ? 201 : 200 },
    );
  } catch {
    return NextResponse.json(
      { error: "The song could not be added." },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin";
import { getAccountFromRequest } from "@/lib/auth";
import { addLibraryToPlaylist, addTrackToPlaylist } from "@/lib/playlists";

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
    const body = (await request.json()) as {
      trackId?: unknown;
      libraryId?: unknown;
    };
    const trackId = typeof body.trackId === "string" ? body.trackId : "";
    const libraryId = typeof body.libraryId === "string" ? body.libraryId : "";
    if (!trackId && !libraryId) {
      return NextResponse.json({ error: "A track is required." }, { status: 400 });
    }
    // Both is not a request this route can honour: libraryId would win and the
    // named track would be dropped under a 201 reporting how many were added.
    // Say so rather than doing something the caller did not ask for.
    if (trackId && libraryId) {
      return NextResponse.json(
        { error: "Send either a track or a library, not both." },
        { status: 400 },
      );
    }
    const bypassLimit = isAdminRequest(request);

    if (libraryId) {
      const result = addLibraryToPlaylist({
        playlistId: id,
        accountId: account.id,
        libraryId,
        bypassLimit,
      });
      if (result.status === "no_playlist") {
        return NextResponse.json({ error: "No such playlist." }, { status: 404 });
      }
      if (result.status === "no_library") {
        return NextResponse.json({ error: "No such library." }, { status: 404 });
      }
      if (result.status === "full" && result.added === 0) {
        return NextResponse.json({ error: "This playlist is full." }, { status: 409 });
      }
      return NextResponse.json(
        { added: result.added, full: result.status === "full" },
        { status: result.added > 0 ? 201 : 200 },
      );
    }

    const result = addTrackToPlaylist({
      playlistId: id,
      accountId: account.id,
      libraryTrackId: trackId,
      bypassLimit,
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
    if (result === "full") {
      return NextResponse.json(
        { error: "This playlist is full." },
        { status: 409 },
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

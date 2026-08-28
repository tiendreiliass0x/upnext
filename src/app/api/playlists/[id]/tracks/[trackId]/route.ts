import { NextResponse } from "next/server";
import { getAccountFromRequest } from "@/lib/auth";
import { removeTrackFromPlaylist } from "@/lib/playlists";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; trackId: string }> },
) {
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  const { id, trackId } = await context.params;
  const removed = removeTrackFromPlaylist({
    playlistId: id,
    accountId: account.id,
    libraryTrackId: trackId,
  });
  if (removed === 0) {
    return NextResponse.json(
      { error: "That song is not in this playlist." },
      { status: 404 },
    );
  }
  return NextResponse.json({ removed: true });
}

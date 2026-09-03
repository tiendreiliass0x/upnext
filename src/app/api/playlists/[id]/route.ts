import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin";
import { getAccountFromRequest } from "@/lib/auth";
import { deletePlaylist, getPlaylist, listPlaylistTracks } from "@/lib/playlists";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  const { id } = await context.params;
  const playlist = getPlaylist(id, account.id);
  // 404 rather than 403 for someone else's playlist: whether it exists is not
  // information this caller is entitled to.
  if (!playlist) {
    return NextResponse.json({ error: "No such playlist." }, { status: 404 });
  }
  return NextResponse.json({
    playlist,
    tracks: listPlaylistTracks(id, account.id, {
      unbounded: isAdminRequest(request),
    }),
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  const { id } = await context.params;
  if (deletePlaylist(id, account.id) === 0) {
    return NextResponse.json({ error: "No such playlist." }, { status: 404 });
  }
  return NextResponse.json({ deleted: true });
}

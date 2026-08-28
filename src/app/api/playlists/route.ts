import { NextResponse } from "next/server";
import { getAccountFromRequest } from "@/lib/auth";
import {
  createPlaylist,
  listPlaylists,
  playlistLimitMessage,
} from "@/lib/playlists";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  return NextResponse.json({ playlists: listPlaylists(account.id) });
}

export async function POST(request: Request) {
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  try {
    const body = (await request.json()) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > 80) {
      return NextResponse.json(
        { error: "Give the playlist a name of 1 to 80 characters." },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { playlist: createPlaylist({ accountId: account.id, name }) },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Error && error.message === playlistLimitMessage) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: "The playlist could not be created." },
      { status: 500 },
    );
  }
}

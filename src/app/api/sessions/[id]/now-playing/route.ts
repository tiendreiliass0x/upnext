import { NextResponse } from "next/server";
import { getAccountFromRequest } from "@/lib/auth";
import { getSession, setNowPlaying } from "@/lib/sessions";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  let trackId: string | "next" | null;
  let fromTrackId: string | null | undefined;
  try {
    const body = (await request.json()) as {
      trackId?: unknown;
      fromTrackId?: unknown;
    };
    if (body.trackId === null) trackId = null;
    else if (body.trackId === "next") trackId = "next";
    else if (typeof body.trackId === "string" && body.trackId.length <= 100) {
      trackId = body.trackId;
    } else {
      return NextResponse.json({ error: "Choose a track." }, { status: 400 });
    }
    if (body.fromTrackId === null) fromTrackId = null;
    else if (typeof body.fromTrackId === "string" && body.fromTrackId.length <= 100) {
      fromTrackId = body.fromTrackId;
    } else if (body.fromTrackId !== undefined) {
      // A guard that cannot be read must not silently become no guard.
      return NextResponse.json({ error: "Choose a track." }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Choose a track." }, { status: 400 });
  }

  const result = setNowPlaying({
    sessionId: id,
    hostKey: request.headers.get("x-upnext-host-key") ?? "",
    accountId: account.id,
    trackId,
    fromTrackId,
  });
  // The song this change was meant to follow is no longer on: someone else
  // already moved the room along. Nothing to do, and nothing went wrong.
  if (result === "stale") {
    return NextResponse.json({ session: getSession(id, account.id), stale: true });
  }
  // Already on: nothing to restamp, nothing to announce.
  if (result === "unchanged") {
    return NextResponse.json({ session: getSession(id, account.id), unchanged: true });
  }

  if (result === "forbidden") {
    return NextResponse.json(
      { error: "Only the DJ can change what is playing." },
      { status: 403 },
    );
  }
  if (result === "not_found") {
    return NextResponse.json(
      { error: "This room is no longer live." },
      { status: 404 },
    );
  }
  if (result === "no_track") {
    return NextResponse.json(
      { error: "Every track in this room is cooling down." },
      { status: 409 },
    );
  }

  return NextResponse.json({ session: getSession(id, account.id) });
}

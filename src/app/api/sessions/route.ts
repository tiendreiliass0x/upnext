import { NextResponse } from "next/server";
import { getAccountFromRequest } from "@/lib/auth";
import { getPublicBaseUrl } from "@/lib/config";
import { createSession, getActiveHostSession } from "@/lib/sessions";
import { InvalidTipHandleError, normalizeTipHandles } from "@/lib/tips";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  return NextResponse.json({
    activeRoom: getActiveHostSession(account.id),
    guestBaseUrl: getPublicBaseUrl(),
  });
}

export async function POST(request: Request) {
  try {
    const account = getAccountFromRequest(request);
    if (!account) {
      return NextResponse.json(
        { error: "Sign in before opening a room." },
        { status: 401 },
      );
    }

    const body = (await request.json()) as {
      name?: unknown;
      venue?: unknown;
      tracks?: unknown;
      requestId?: unknown;
      cashAppHandle?: unknown;
      venmoHandle?: unknown;
    };

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const venue = typeof body.venue === "string" ? body.venue.trim() : "";
    const rawTracks = Array.isArray(body.tracks) ? body.tracks : [];
    const tracks = rawTracks
      .filter(
        (track): track is {
          title: string;
          artist: string;
          previewKey?: string | null;
        } =>
          typeof track === "object" &&
          track !== null &&
          typeof (track as { title?: unknown }).title === "string" &&
          typeof (track as { artist?: unknown }).artist === "string",
      )
      .slice(0, 200)
      .map((track) => ({
        title: track.title.trim().slice(0, 120),
        artist: track.artist.trim().slice(0, 120) || "Unknown artist",
        previewKey:
          typeof track.previewKey === "string"
            ? track.previewKey.slice(0, 500)
            : null,
      }))
      .filter((track) => track.title.length > 0);

    if (!name || tracks.length === 0) {
      return NextResponse.json(
        { error: "Add a session name and at least one track." },
        { status: 400 },
      );
    }

    let tipHandles;
    try {
      tipHandles = normalizeTipHandles({
        cashApp: body.cashAppHandle,
        venmo: body.venmoHandle,
      });
    } catch (error) {
      if (error instanceof InvalidTipHandleError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    const result = createSession({
      name: name.slice(0, 80),
      venue: venue.slice(0, 80),
      accountId: account.id,
      requestId:
        typeof body.requestId === "string"
          ? body.requestId.trim().slice(0, 100)
          : null,
      tipHandles,
      tracks,
    });

    return NextResponse.json(
      { ...result, guestBaseUrl: getPublicBaseUrl() },
      { status: 201 },
    );
  } catch {
    return NextResponse.json(
      { error: "The session could not be created." },
      { status: 500 },
    );
  }
}

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getAccountFromRequest } from "@/lib/auth";
import {
  endSession,
  getAnonymousSession,
  getSession,
  getSessionRevision,
} from "@/lib/sessions";
import { getAnonymousVoterId } from "@/lib/voters";

export const dynamic = "force-dynamic";

// The room payload carries per-viewer fields (votedTrackIds, anonymousVoteUsed),
// so the tag has to identify the viewer as well as the room revision. The viewer
// is hashed to keep voter IDs out of a header that ends up in logs and proxies.
function buildRoomTag(sessionId: string, revision: number, viewerKey: string) {
  const viewer = createHash("sha256")
    .update(viewerKey)
    .digest("hex")
    .slice(0, 16);
  return `"${sessionId}-${revision}-${viewer}"`;
}

function matchesRoomTag(header: string | null, tag: string) {
  if (!header) return false;
  return header
    .split(",")
    .map((candidate) => candidate.trim())
    .some(
      (candidate) =>
        candidate === "*" ||
        candidate === tag ||
        candidate.replace(/^W\//, "") === tag,
    );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const account = getAccountFromRequest(request);
  const anonymousVoterId = account ? null : getAnonymousVoterId(request);
  const viewerKey = account
    ? `account:${account.id}`
    : anonymousVoterId
      ? `voter:${anonymousVoterId}`
      : "public";

  // Guests poll this route every two seconds and the room is usually unchanged,
  // so settle the conditional request on a primary-key read of the revision
  // before running the vote aggregate.
  const current = getSessionRevision(id);
  if (current) {
    const tag = buildRoomTag(current.id, current.revision, viewerKey);
    if (matchesRoomTag(request.headers.get("if-none-match"), tag)) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: tag, "Cache-Control": "no-store" },
      });
    }
  }

  const session = account
    ? getSession(id, account.id)
    : anonymousVoterId
      ? getAnonymousSession(id, anonymousVoterId)
      : getSession(id);

  if (!session) {
    return NextResponse.json(
      { error: "This room is no longer live." },
      { status: 404 },
    );
  }

  return NextResponse.json(
    { session },
    {
      headers: {
        // Built from the returned body so a vote landing mid-request can never
        // pair a stale tag with fresh data.
        ETag: buildRoomTag(session.id, session.revision, viewerKey),
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const hostKey = request.headers.get("x-upnext-host-key") ?? "";
  const result = endSession({
    sessionId: id,
    hostKey,
    accountId: account.id,
  });

  if (result === "forbidden") {
    return NextResponse.json(
      { error: "Only the DJ can end this room." },
      { status: 403 },
    );
  }

  if (result === "not_found") {
    return NextResponse.json(
      { error: "This room is no longer live." },
      { status: 404 },
    );
  }

  return NextResponse.json({ ended: true });
}

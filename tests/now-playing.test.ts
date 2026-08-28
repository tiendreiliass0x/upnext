import { describe, expect, it } from "vitest";
import { POST as nowPlayingRoute } from "@/app/api/sessions/[id]/now-playing/route";
import { GET as getRoom } from "@/app/api/sessions/[id]/route";
import { createAccount } from "@/lib/accounts";
import {
  castAnonymousVote,
  createSession,
  getSession,
  setNowPlaying,
} from "@/lib/sessions";
import { setupTestDatabase } from "./helpers/database";

setupTestDatabase();

function room(accountId: string) {
  return createSession({
    name: "Set",
    venue: "",
    accountId,
    requestId: crypto.randomUUID(),
    tracks: [
      { title: "Opener", artist: "A" },
      { title: "Banger", artist: "B" },
      { title: "Closer", artist: "C" },
    ],
  });
}

function trackId(sessionId: string, title: string) {
  const track = getSession(sessionId)!.tracks.find((item) => item.title === title);
  if (!track) throw new Error(`no track ${title}`);
  return track.id;
}

describe("setNowPlaying", () => {
  it("plays the crowd pick, then the next unplayed one, and bumps the revision", () => {
    const host = createAccount({ phone: "+32470000060", pseudonym: "Host" });
    const { session, hostKey } = room(host.id);
    castAnonymousVote({
      sessionId: session.id,
      trackId: trackId(session.id, "Banger"),
      voterId: "voter-1",
    });
    const before = getSession(session.id)!.revision;

    expect(
      setNowPlaying({ sessionId: session.id, hostKey, accountId: host.id, trackId: "next" }),
    ).toBe("updated");
    let current = getSession(session.id)!;
    expect(current.nowPlaying?.title).toBe("Banger");
    expect(current.revision).toBe(before + 1);
    // The played song leaves the top of the ballot even though it holds the vote.
    expect(current.tracks.map((track) => track.title)).toEqual(["Opener", "Closer", "Banger"]);
    expect(current.tracks[2].playedAt).toBeTruthy();

    setNowPlaying({ sessionId: session.id, hostKey, accountId: host.id, trackId: "next" });
    current = getSession(session.id)!;
    expect(current.nowPlaying?.title).toBe("Opener");

    setNowPlaying({ sessionId: session.id, hostKey, accountId: host.id, trackId: "next" });
    expect(
      setNowPlaying({ sessionId: session.id, hostKey, accountId: host.id, trackId: "next" }),
    ).toBe("no_track");
  });

  it("takes a chosen track, or nothing, and refuses tracks from another room", () => {
    const host = createAccount({ phone: "+32470000061", pseudonym: "Host" });
    const other = createAccount({ phone: "+32470000062", pseudonym: "Other" });
    const mine = room(host.id);
    const theirs = room(other.id);
    const closer = trackId(mine.session.id, "Closer");

    expect(
      setNowPlaying({ sessionId: mine.session.id, hostKey: mine.hostKey, accountId: host.id, trackId: closer }),
    ).toBe("updated");
    expect(getSession(mine.session.id)!.nowPlaying?.trackId).toBe(closer);

    expect(
      setNowPlaying({
        sessionId: mine.session.id,
        hostKey: mine.hostKey,
        accountId: host.id,
        trackId: trackId(theirs.session.id, "Opener"),
      }),
    ).toBe("no_track");

    expect(
      setNowPlaying({ sessionId: mine.session.id, hostKey: mine.hostKey, accountId: host.id, trackId: null }),
    ).toBe("updated");
    expect(getSession(mine.session.id)!.nowPlaying).toBeNull();
  });

  it("only the host with the host key can change it", () => {
    const host = createAccount({ phone: "+32470000063", pseudonym: "Host" });
    const stranger = createAccount({ phone: "+32470000064", pseudonym: "Stranger" });
    const { session, hostKey } = room(host.id);
    expect(
      setNowPlaying({ sessionId: session.id, hostKey: "wrong", accountId: host.id, trackId: "next" }),
    ).toBe("forbidden");
    expect(
      setNowPlaying({ sessionId: session.id, hostKey, accountId: stranger.id, trackId: "next" }),
    ).toBe("forbidden");
    expect(
      setNowPlaying({ sessionId: "NOPE01", hostKey, accountId: host.id, trackId: "next" }),
    ).toBe("not_found");
    expect(getSession(session.id)!.nowPlaying).toBeNull();
  });
});

describe("POST /api/sessions/[id]/now-playing", () => {
  function call(id: string, token: string | null, hostKey: string, body: unknown) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-upnext-host-key": hostKey,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return nowPlayingRoute(
      new Request(`http://localhost/api/sessions/${id}/now-playing`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  it("gates on sign-in and host key, then shows guests what is on", async () => {
    const host = createAccount({ phone: "+32470000065", pseudonym: "Host" });
    const { session, hostKey } = room(host.id);

    expect((await call(session.id, null, hostKey, { trackId: "next" })).status).toBe(401);
    expect((await call(session.id, host.authToken, "wrong", { trackId: "next" })).status).toBe(403);
    expect((await call(session.id, host.authToken, hostKey, { trackId: 42 })).status).toBe(400);

    const ok = await call(session.id, host.authToken, hostKey, { trackId: "next" });
    expect(ok.status).toBe(200);
    const payload = (await ok.json()) as { session: { nowPlaying: { title: string } } };
    expect(payload.session.nowPlaying.title).toBe("Opener");

    const guest = await getRoom(
      new Request(`http://localhost/api/sessions/${session.id}`, {
        headers: { "x-upnext-voter-id": "8b1d2a4e-1c3f-4a5b-9d6e-7f8091a2b3c4" },
      }),
      { params: Promise.resolve({ id: session.id }) },
    );
    const guestPayload = (await guest.json()) as {
      session: { nowPlaying: { title: string; previewUrl: string | null; startedAt: string } };
    };
    expect(guestPayload.session.nowPlaying.title).toBe("Opener");
    expect(guestPayload.session.nowPlaying.startedAt).toBeTruthy();

    for (let round = 0; round < 2; round += 1) {
      await call(session.id, host.authToken, hostKey, { trackId: "next" });
    }
    expect((await call(session.id, host.authToken, hostKey, { trackId: "next" })).status).toBe(409);
  });
});

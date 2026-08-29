import { describe, expect, it } from "vitest";
import { POST as nowPlayingRoute } from "@/app/api/sessions/[id]/now-playing/route";
import { GET as getRoom } from "@/app/api/sessions/[id]/route";
import { POST as voteRoute } from "@/app/api/sessions/[id]/vote/route";
import { createAccount } from "@/lib/accounts";
import {
  CooldownError,
  castAnonymousVote,
  cooldownMessage,
  createSession,
  getAnonymousSession,
  getSession,
  setNowPlaying,
  toggleVote,
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

    // Two songs have rolled since Banger, so it is open again — with its
    // earlier vote spent, it comes back on position, not on old votes.
    setNowPlaying({ sessionId: session.id, hostKey, accountId: host.id, trackId: "next" });
    current = getSession(session.id)!;
    expect(current.nowPlaying?.title).toBe("Closer");
    const banger = current.tracks.find((track) => track.title === "Banger")!;
    expect(banger.cooldown).toBe(0);
    expect(banger.votes).toBe(0);
    expect(
      setNowPlaying({ sessionId: session.id, hostKey, accountId: host.id, trackId: "next" }),
    ).toBe("updated");
    expect(getSession(session.id)!.nowPlaying?.title).toBe("Banger");
  });

  it("never runs dry: a one-track room replays its song, a two-track room alternates", () => {
    const host = createAccount({ phone: "+32470000085", pseudonym: "Host" });
    const play = (sessionId: string, hostKey: string) =>
      setNowPlaying({ sessionId, hostKey, accountId: host.id, trackId: "next" });
    const solo = createSession({
      name: "Solo",
      venue: "",
      accountId: host.id,
      requestId: crypto.randomUUID(),
      tracks: [{ title: "Only", artist: "A" }],
    });
    expect(play(solo.session.id, solo.hostKey)).toBe("updated");
    expect(play(solo.session.id, solo.hostKey)).toBe("updated");
    // A room too small to cool down does not pretend to: nothing to wait for.
    expect(getSession(solo.session.id)!.tracks[0].cooldown).toBe(0);

    const pair = createSession({
      name: "Pair",
      venue: "",
      accountId: host.id,
      requestId: crypto.randomUUID(),
      tracks: [
        { title: "One", artist: "A" },
        { title: "Two", artist: "A" },
      ],
    });
    const titles: string[] = [];
    for (let round = 0; round < 4; round += 1) {
      expect(play(pair.session.id, pair.hostKey)).toBe("updated");
      titles.push(getSession(pair.session.id)!.nowPlaying!.title);
    }
    expect(titles).toEqual(["One", "Two", "One", "Two"]);
    // The one just played cools for a single song, since only one can roll.
    const current = getSession(pair.session.id)!;
    expect(current.tracks.find((t) => t.title === "Two")?.cooldown).toBe(1);
    expect(current.tracks.find((t) => t.title === "One")?.cooldown).toBe(0);
  });

  it("gives every song its turn before repeating, even with no votes", () => {
    const host = createAccount({ phone: "+32470000086", pseudonym: "Host" });
    const { session, hostKey } = createSession({
      name: "Long set",
      venue: "",
      accountId: host.id,
      requestId: crypto.randomUUID(),
      tracks: ["T1", "T2", "T3", "T4", "T5"].map((title) => ({ title, artist: "A" })),
    });
    const titles: string[] = [];
    for (let round = 0; round < 10; round += 1) {
      setNowPlaying({ sessionId: session.id, hostKey, accountId: host.id, trackId: "next" });
      titles.push(getSession(session.id)!.nowPlaying!.title);
    }
    // Before the fix a reopened song tied the never-played ones at zero votes
    // and won on position, so T4 and T5 never played.
    expect(titles).toEqual(["T1", "T2", "T3", "T4", "T5", "T1", "T2", "T3", "T4", "T5"]);
    // The ballot shows the same order the pick will follow.
    expect(getSession(session.id)!.tracks.map((t) => t.title)).toEqual([
      "T1", "T2", "T3", "T4", "T5",
    ]);
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
    // Two songs have rolled since Opener, so the room never runs dry: it is
    // the crowd pick again rather than a 409.
    const again = await call(session.id, host.authToken, hostKey, { trackId: "next" });
    expect(again.status).toBe(200);
    expect(
      ((await again.json()) as { session: { nowPlaying: { title: string } } }).session
        .nowPlaying.title,
    ).toBe("Opener");
  });
});

describe("voting on a track that is cooling down", () => {
  function request(url: string, init: { body: unknown; token?: string; voterId?: string }) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    if (init.voterId) headers["x-upnext-voter-id"] = init.voterId;
    return new Request(url, { method: "POST", headers, body: JSON.stringify(init.body) });
  }

  it("is refused with how many songs are left, and the free vote is not consumed", () => {
    const host = createAccount({ phone: "+32470000070", pseudonym: "Host" });
    const guest = createAccount({ phone: "+32470000071", pseudonym: "Guest" });
    const { session, hostKey } = room(host.id);
    const played = trackId(session.id, "Opener");
    expect(
      setNowPlaying({ sessionId: session.id, hostKey, accountId: host.id, trackId: played }),
    ).toBe("updated");

    expect(() =>
      toggleVote({ sessionId: session.id, trackId: played, accountId: guest.id, enabled: true }),
    ).toThrow(cooldownMessage(2));
    expect(cooldownMessage(2)).toMatch(/two more songs have rolled/);
    expect(cooldownMessage(1)).toMatch(/one more song has rolled/);
    expect(
      castAnonymousVote({ sessionId: session.id, trackId: played, voterId: "late-phone-1" }),
    ).toMatchObject({ status: "cooldown", songsRemaining: 2 });
    // The free vote was not consumed by the refusal.
    expect(
      castAnonymousVote({
        sessionId: session.id,
        trackId: trackId(session.id, "Banger"),
        voterId: "late-phone-1",
      }),
    ).toMatchObject({ status: "voted" });
  });

  it("still lets an account take its earlier vote back off a played track", () => {
    const host = createAccount({ phone: "+32470000072", pseudonym: "Host" });
    const guest = createAccount({ phone: "+32470000073", pseudonym: "Guest" });
    const { session, hostKey } = room(host.id);
    const played = trackId(session.id, "Opener");
    toggleVote({ sessionId: session.id, trackId: played, accountId: guest.id, enabled: true });
    setNowPlaying({ sessionId: session.id, hostKey, accountId: host.id, trackId: played });

    const result = toggleVote({
      sessionId: session.id,
      trackId: played,
      accountId: guest.id,
      enabled: false,
    });
    expect(result?.voted).toBe(false);
  });

  it("answers 409 with a code the client can act on", async () => {
    const host = createAccount({ phone: "+32470000074", pseudonym: "Host" });
    const guest = createAccount({ phone: "+32470000075", pseudonym: "Guest" });
    const { session, hostKey } = room(host.id);
    const played = trackId(session.id, "Opener");
    setNowPlaying({ sessionId: session.id, hostKey, accountId: host.id, trackId: played });

    for (const init of [
      { body: { trackId: played, enabled: true }, token: guest.authToken },
      { body: { trackId: played, enabled: true }, voterId: "late-phone-voter-0002" },
    ]) {
      const response = await voteRoute(
        request(`http://localhost/api/sessions/${session.id}/vote`, init),
        { params: Promise.resolve({ id: session.id }) },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "COOLDOWN", songsRemaining: 2 });
    }
  });

  it("opens the song again after two more have rolled, and counts only new votes", () => {
    const host = createAccount({ phone: "+32470000076", pseudonym: "Host" });
    const guest = createAccount({ phone: "+32470000077", pseudonym: "Guest" });
    const { session, hostKey } = room(host.id);
    const opener = trackId(session.id, "Opener");
    const play = (id: string) =>
      setNowPlaying({ sessionId: session.id, hostKey, accountId: host.id, trackId: id });

    toggleVote({ sessionId: session.id, trackId: opener, accountId: guest.id, enabled: true });
    play(opener);
    play(trackId(session.id, "Banger"));
    // One more to go.
    let error: unknown;
    try {
      toggleVote({ sessionId: session.id, trackId: opener, accountId: guest.id, enabled: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CooldownError);
    expect((error as CooldownError).songsRemaining).toBe(1);
    expect(getSession(session.id)!.tracks.find((t) => t.id === opener)?.cooldown).toBe(1);

    play(trackId(session.id, "Closer"));
    const reopened = getSession(session.id)!.tracks.find((t) => t.id === opener)!;
    expect(reopened.cooldown).toBe(0);
    // The vote from before it played was spent with that play.
    expect(reopened.votes).toBe(0);
    const again = toggleVote({
      sessionId: session.id,
      trackId: opener,
      accountId: guest.id,
      enabled: true,
    });
    expect(again?.voted).toBe(true);
    expect(again?.session.tracks.find((t) => t.id === opener)?.votes).toBe(1);
  });
});

describe("votes across a play", () => {
  it("keeps the room's totals when a song plays, and shows only live picks", () => {
    const host = createAccount({ phone: "+32470000080", pseudonym: "Host" });
    const fans = ["+32470000081", "+32470000082", "+32470000083"].map((phone) =>
      createAccount({ phone, pseudonym: "Fan" }),
    );
    const { session, hostKey } = room(host.id);
    const opener = trackId(session.id, "Opener");
    for (const fan of fans) {
      toggleVote({ sessionId: session.id, trackId: opener, accountId: fan.id, enabled: true });
    }
    const before = getSession(session.id, fans[0].id)!;
    expect(before).toMatchObject({ totalVotes: 3, guestCount: 3, votedTrackIds: [opener] });

    setNowPlaying({ sessionId: session.id, hostKey, accountId: host.id, trackId: opener });

    const after = getSession(session.id, fans[0].id)!;
    // The header does not read like the room emptied out.
    expect(after).toMatchObject({ totalVotes: 3, guestCount: 3 });
    // But the spent votes no longer rank the song or show as anyone's pick.
    expect(after.tracks.find((t) => t.id === opener)?.votes).toBe(0);
    expect(after.votedTrackIds).toEqual([]);
  });

  it("lets an anonymous guest re-tap their free vote once the song is open again", () => {
    const host = createAccount({ phone: "+32470000084", pseudonym: "Host" });
    const { session, hostKey } = room(host.id);
    const opener = trackId(session.id, "Opener");
    const voterId = "anonymous-voter-00000001";
    const play = (id: string) =>
      setNowPlaying({ sessionId: session.id, hostKey, accountId: host.id, trackId: id });

    expect(
      castAnonymousVote({ sessionId: session.id, trackId: opener, voterId }),
    ).toMatchObject({ status: "voted" });
    play(opener);
    play(trackId(session.id, "Banger"));
    play(trackId(session.id, "Closer"));

    const between = getAnonymousSession(session.id, voterId)!;
    expect(between.anonymousVoteUsed).toBe(true);
    // The spent tap is no longer shown as a live pick, so the guest can tap again.
    expect(between.votedTrackIds).toEqual([]);
    const revision = between.revision;

    const again = castAnonymousVote({ sessionId: session.id, trackId: opener, voterId });
    expect(again).toMatchObject({ status: "voted", voted: true });
    if (again.status !== "voted") throw new Error("not voted");
    // Before the fix this answered "voted" and changed nothing.
    expect(again.session.tracks.find((t) => t.id === opener)?.votes).toBe(1);
    expect(again.session.votedTrackIds).toEqual([opener]);
    expect(again.session.revision).toBe(revision + 1);
    // Still one free vote, now live on Opener again.
    expect(getAnonymousSession(session.id, voterId)).toMatchObject({
      anonymousVoteUsed: true,
      votedTrackIds: [opener],
    });
  });
});

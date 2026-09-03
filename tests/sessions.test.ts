import { describe, expect, it } from "vitest";
import { claimAnonymousVoter, createAccount } from "@/lib/accounts";
import { closeDatabase, getDatabase } from "@/lib/db";
import {
  castAnonymousVote,
  createSession,
  endSession,
  getActiveHostSession,
  getAnonymousSession,
  getSession,
  getTrackPreviewKey,
  registerAudioUpload,
  roomVoterPreviewLimit,
  setNowPlaying,
  toggleVote,
  voterPreviewLimit,
} from "@/lib/sessions";
import { setupTestDatabase } from "./helpers/database";

const testDatabase = setupTestDatabase();

function account(phone: string, pseudonym: string) {
  return createAccount({ phone, pseudonym });
}

function room(accountId: string, requestId = crypto.randomUUID()) {
  return createSession({
    name: "Friday Room",
    venue: "Room 02",
    accountId,
    requestId,
    tracks: [
      { title: "First", artist: "Artist A" },
      { title: "Second", artist: "Artist B" },
      { title: "Third", artist: "Artist C" },
    ],
  });
}

describe("sessions", () => {
  it("identifies the DJ on the public room", () => {
    const host = account("+32470000096", "DJ Owl");
    const created = createSession({
      name: "Friday Room",
      venue: "Room 02",
      accountId: host.id,
      requestId: "named-dj-room",
      tipHandles: { cashApp: "DJOwl", venmo: "dj-owl" },
      tracks: [{ title: "First", artist: "Artist A" }],
    });

    expect(created.session.djName).toBe("DJ Owl");
    expect(created.session.tipLinks).toEqual({
      cashApp: "https://cash.app/$DJOwl",
      venmo: "https://account.venmo.com/u/dj-owl",
    });
    expect(getSession(created.session.id)?.djName).toBe("DJ Owl");
  });

  it("counts account and anonymous votes per track without leaking across rooms", () => {
    const host = account("+32470000099", "Counter Host");
    const guestOne = account("+32470000098", "Guest One");
    const guestTwo = account("+32470000097", "Guest Two");
    const watched = room(host.id, "counted-room");
    const other = room(host.id, "other-room");
    const [firstTrack, secondTrack] = watched.session.tracks;

    // Votes in a different room must never reach this room's totals.
    other.session.tracks.forEach((track) => {
      toggleVote({
        sessionId: other.session.id,
        trackId: track.id,
        accountId: guestOne.id,
        enabled: true,
      });
    });

    toggleVote({
      sessionId: watched.session.id,
      trackId: firstTrack.id,
      accountId: guestOne.id,
      enabled: true,
    });
    toggleVote({
      sessionId: watched.session.id,
      trackId: firstTrack.id,
      accountId: guestTwo.id,
      enabled: true,
    });
    castAnonymousVote({
      sessionId: watched.session.id,
      trackId: firstTrack.id,
      voterId: "anonymous-counter-voter-1",
    });
    castAnonymousVote({
      sessionId: watched.session.id,
      trackId: secondTrack.id,
      voterId: "anonymous-counter-voter-2",
    });

    const view = getSession(watched.session.id);
    const votesByTitle = Object.fromEntries(
      view?.tracks.map((track) => [track.title, track.votes]) ?? [],
    );

    expect(votesByTitle).toEqual({ First: 3, Second: 1, Third: 0 });
    expect(view?.tracks.map((track) => track.title)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
    expect(getSession(other.session.id)?.tracks.every((track) => track.votes === 1)).toBe(
      true,
    );
  });

  it("keeps upload order while votes are tied", () => {
    const host = account("+32470000011", "Host");
    const created = room(host.id);

    expect(created.session.tracks.map((track) => track.title)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
    expect(created.session.totalVotes).toBe(0);
  });

  it("sorts by votes and tracks voter-specific selected state", () => {
    const host = account("+32470000012", "Host");
    const guestA = account("+32470000013", "Guest A");
    const guestB = account("+32470000014", "Guest B");
    const created = room(host.id);
    const secondTrack = created.session.tracks[1];

    const firstVote = toggleVote({
      sessionId: created.session.id.toLowerCase(),
      trackId: secondTrack.id,
      accountId: guestA.id,
    });
    expect(firstVote?.voted).toBe(true);
    expect(firstVote?.session.tracks[0].id).toBe(secondTrack.id);
    expect(firstVote?.session.votedTrackIds).toEqual([secondTrack.id]);

    toggleVote({
      sessionId: created.session.id,
      trackId: secondTrack.id,
      accountId: guestB.id,
    });
    const guestAView = getSession(created.session.id, guestA.id);
    const hostView = getSession(created.session.id, host.id);
    expect(guestAView?.totalVotes).toBe(2);
    expect(guestAView?.guestCount).toBe(2);
    expect(guestAView?.votedTrackIds).toEqual([secondTrack.id]);
    expect(hostView?.votedTrackIds).toEqual([]);

    const removed = toggleVote({
      sessionId: created.session.id,
      trackId: secondTrack.id,
      accountId: guestA.id,
    });
    expect(removed?.voted).toBe(false);
    expect(removed?.session.totalVotes).toBe(1);
  });

  it("allows one idempotent anonymous vote per room and claims it on signup", () => {
    const host = account("+32470000044", "Host");
    const created = room(host.id);
    const voterId = "browser-voter-0000000000000001";
    const firstTrack = created.session.tracks[0];
    const secondTrack = created.session.tracks[1];

    const first = castAnonymousVote({
      sessionId: created.session.id,
      trackId: firstTrack.id,
      voterId,
    });
    expect(first.status).toBe("voted");
    if (first.status !== "voted") throw new Error("Anonymous vote failed");
    expect(first.session.totalVotes).toBe(1);
    expect(first.session.guestCount).toBe(1);
    expect(first.session.votedTrackIds).toEqual([firstTrack.id]);

    const repeated = castAnonymousVote({
      sessionId: created.session.id,
      trackId: firstTrack.id,
      voterId,
    });
    expect(repeated.status).toBe("voted");
    if (repeated.status !== "voted") throw new Error("Vote retry failed");
    expect(repeated.session.totalVotes).toBe(1);

    expect(
      castAnonymousVote({
        sessionId: created.session.id,
        trackId: secondTrack.id,
        voterId,
      }),
    ).toEqual({ status: "phone_required" });

    const claimedAccount = createAccount({
      phone: "+32470000045",
      pseudonym: "Claimed Guest",
      anonymousVoterId: voterId,
    });
    const claimedView = getSession(created.session.id, claimedAccount.id);
    expect(claimedView?.totalVotes).toBe(1);
    expect(claimedView?.guestCount).toBe(1);
    expect(claimedView?.votedTrackIds).toEqual([firstTrack.id]);
    expect(getAnonymousSession(created.session.id, voterId)?.votedTrackIds).toEqual(
      [],
    );
    expect(
      castAnonymousVote({
        sessionId: created.session.id,
        trackId: secondTrack.id,
        voterId,
      }),
    ).toEqual({ status: "phone_required" });

    const second = toggleVote({
      sessionId: created.session.id,
      trackId: secondTrack.id,
      accountId: claimedAccount.id,
    });
    expect(second?.session.totalVotes).toBe(2);
    expect(second?.session.votedTrackIds).toEqual(
      expect.arrayContaining([firstTrack.id, secondTrack.id]),
    );
  });

  it("claims a free vote when an existing account logs in", () => {
    const host = account("+32470000051", "Host");
    const returningGuest = account("+32470000052", "Returning Guest");
    const created = room(host.id);
    const voterId = "returning-voter-00000000000001";
    const trackId = created.session.tracks[1].id;

    expect(
      castAnonymousVote({
        sessionId: created.session.id,
        trackId,
        voterId,
      }).status,
    ).toBe("voted");
    claimAnonymousVoter({ accountId: returningGuest.id, voterId });

    const accountView = getSession(created.session.id, returningGuest.id);
    expect(accountView?.totalVotes).toBe(1);
    expect(accountView?.guestCount).toBe(1);
    expect(accountView?.votedTrackIds).toEqual([trackId]);
    expect(
      castAnonymousVote({
        sessionId: created.session.id,
        trackId: created.session.tracks[2].id,
        voterId,
      }),
    ).toEqual({ status: "phone_required" });
  });

  it("makes explicit account vote writes idempotent", () => {
    const host = account("+32470000047", "Host");
    const guest = account("+32470000048", "Guest");
    const created = room(host.id);
    const trackId = created.session.tracks[0].id;

    const first = toggleVote({
      sessionId: created.session.id,
      trackId,
      accountId: guest.id,
      enabled: true,
    });
    const retry = toggleVote({
      sessionId: created.session.id,
      trackId,
      accountId: guest.id,
      enabled: true,
    });
    expect(first?.session.totalVotes).toBe(1);
    expect(retry?.session.totalVotes).toBe(1);
    expect(retry?.session.revision).toBe(first?.session.revision);

    const removed = toggleVote({
      sessionId: created.session.id,
      trackId,
      accountId: guest.id,
      enabled: false,
    });
    const removeRetry = toggleVote({
      sessionId: created.session.id,
      trackId,
      accountId: guest.id,
      enabled: false,
    });
    expect(removed?.session.totalVotes).toBe(0);
    expect(removeRetry?.session.revision).toBe(removed?.session.revision);
  });

  it("gives the same anonymous voter one free vote in each room", () => {
    const host = account("+32470000046", "Host");
    const firstRoom = room(host.id, "anonymous-room-one");
    const secondRoom = room(host.id, "anonymous-room-two");
    const voterId = "browser-voter-0000000000000002";

    expect(
      castAnonymousVote({
        sessionId: firstRoom.session.id,
        trackId: firstRoom.session.tracks[0].id,
        voterId,
      }).status,
    ).toBe("voted");
    expect(
      castAnonymousVote({
        sessionId: secondRoom.session.id,
        trackId: secondRoom.session.tracks[0].id,
        voterId,
      }).status,
    ).toBe("voted");
  });

  it("rejects vote rows whose track belongs to another session", () => {
    const host = account("+32470000049", "Host");
    const guest = account("+32470000050", "Guest");
    const firstRoom = room(host.id, "constraint-room-one");
    const secondRoom = room(host.id, "constraint-room-two");

    expect(() =>
      getDatabase()
        .prepare(
          `INSERT INTO votes (track_id, session_id, account_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          firstRoom.session.tracks[0].id,
          secondRoom.session.id,
          guest.id,
          new Date().toISOString(),
        ),
    ).toThrow("vote track/session mismatch");

    toggleVote({
      sessionId: firstRoom.session.id,
      trackId: firstRoom.session.tracks[0].id,
      accountId: guest.id,
      enabled: true,
    });
    expect(() =>
      getDatabase()
        .prepare("UPDATE tracks SET session_id = ? WHERE id = ?")
        .run(secondRoom.session.id, firstRoom.session.tracks[0].id),
    ).toThrow("voted track session cannot change");
  });

  it("deduplicates room creation by host request ID", () => {
    const host = account("+32470000015", "Host");
    const requestId = "stable-request";
    const first = room(host.id, requestId);
    const repeated = room(host.id, requestId);

    expect(repeated.session.id).toBe(first.session.id);
    expect(repeated.hostKey).toBe(first.hostKey);
    const count = getDatabase()
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE request_id = ?")
      .get(requestId) as { count: number };
    expect(count.count).toBe(1);
  });

  it("takes the handles from a retried launch, and leaves the room alone otherwise", () => {
    const host = account("+32470000018", "Retrying Host");
    const requestId = "retried-launch";
    const first = createSession({
      name: "Tip Room",
      venue: "",
      accountId: host.id,
      requestId,
      tipHandles: { cashApp: "DJ0wl", venmo: null },
      tracks: [{ title: "Track", artist: "Artist" }],
    });
    const beforeRetry = getSession(first.session.id)?.revision ?? -1;

    // The first POST landed but the client never heard back, so the DJ fixes
    // the cashtag they mistyped and presses Start again.
    const retried = createSession({
      name: "Tip Room",
      venue: "",
      accountId: host.id,
      requestId,
      tipHandles: { cashApp: "DJOwl", venmo: null },
      tracks: [{ title: "Track", artist: "Artist" }],
    });

    expect(retried.session.id).toBe(first.session.id);
    const corrected = getSession(first.session.id);
    expect(corrected?.tipLinks.cashApp).toBe("https://cash.app/$DJOwl");
    // A guest already in the room has to be told, so the tag stops matching.
    expect(corrected?.revision).toBeGreaterThan(beforeRetry);

    // A retry that changes nothing leaves the room exactly where it was.
    createSession({
      name: "Tip Room",
      venue: "",
      accountId: host.id,
      requestId,
      tipHandles: { cashApp: "DJOwl", venmo: null },
      tracks: [{ title: "Track", artist: "Artist" }],
    });
    expect(getSession(first.session.id)?.revision).toBe(corrected?.revision);
    const count = getDatabase()
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE request_id = ?")
      .get(requestId) as { count: number };
    expect(count.count).toBe(1);
  });

  it("only links previews uploaded by the host account", () => {
    const owner = account("+32470000016", "Owner");
    const other = account("+32470000017", "Other");
    registerAudioUpload({
      objectKey: "previews/owner/sample.mp3",
      accountId: owner.id,
      originalName: "sample.mp3",
      requestId: "upload-1",
    });

    const ownerRoom = createSession({
      name: "Owner Room",
      venue: "",
      accountId: owner.id,
      tracks: [
        {
          title: "Preview",
          artist: "Owner",
          previewKey: "previews/owner/sample.mp3",
        },
      ],
    });
    const otherRoom = createSession({
      name: "Other Room",
      venue: "",
      accountId: other.id,
      tracks: [
        {
          title: "Stolen Preview",
          artist: "Other",
          previewKey: "previews/owner/sample.mp3",
        },
      ],
    });

    expect(ownerRoom.session.tracks[0].previewUrl).toContain("/preview");
    // Another DJ naming someone else's object gets a row with no audio at all,
    // so there is nothing for the room to ask for.
    expect(otherRoom.session.tracks[0].previewUrl).toBeNull();
    expect(getTrackPreviewKey(otherRoom.session.tracks[0].id)).toBeNull();
    // A row of a live room plays for whoever holds the link, on air or not:
    // the crowd votes with their ears.
    expect(getTrackPreviewKey(ownerRoom.session.tracks[0].id)).toBe(
      "previews/owner/sample.mp3",
    );
    setNowPlaying({
      sessionId: ownerRoom.session.id,
      hostKey: ownerRoom.hostKey,
      accountId: owner.id,
      trackId: ownerRoom.session.tracks[0].id,
    });
    expect(getTrackPreviewKey(ownerRoom.session.tracks[0].id)).toBe(
      "previews/owner/sample.mp3",
    );
    // The night ending takes the set with it.
    endSession({
      sessionId: ownerRoom.session.id,
      hostKey: ownerRoom.hostKey,
      accountId: owner.id,
    });
    expect(getTrackPreviewKey(ownerRoom.session.tracks[0].id)).toBeNull();
  });

  it("lists who voted, named first, without leaking voter identifiers", () => {
    const host = account("+32470000090", "Host");
    const amyr = account("+32470000091", "Amyr");
    const nathan = account("+32470000092", "Nathan");
    const created = room(host.id);
    const target = created.session.tracks[0].id;
    castAnonymousVote({ sessionId: created.session.id, trackId: target, voterId: "secret-voter" });
    toggleVote({ sessionId: created.session.id, trackId: target, accountId: amyr.id });
    toggleVote({ sessionId: created.session.id, trackId: target, accountId: nathan.id });

    const track = getSession(created.session.id)!.tracks.find((item) => item.id === target)!;
    expect(track.votes).toBe(3);
    // Named faces lead; the two account votes may share a timestamp.
    expect(track.voters.slice(0, 2).map((voter) => voter.name).sort()).toEqual(["Amyr", "Nathan"]);
    expect(track.voters[2]).toEqual({ name: null, avatarUrl: null });
    expect(JSON.stringify(track)).not.toContain("secret-voter");
    expect(JSON.stringify(track)).not.toContain(amyr.id);

    // Votes spent by a play take their faces with them.
    setNowPlaying({
      sessionId: created.session.id,
      hostKey: created.hostKey,
      accountId: host.id,
      trackId: target,
    });
    expect(getSession(created.session.id)!.tracks.find((item) => item.id === target)!.voters).toEqual([]);
  });

  it("stacks the room's voters once each, named first, capped for the header", () => {
    const host = account("+32470000094", "Host");
    const amyr = account("+32470000095", "Amyr");
    const created = room(host.id);
    const [first, second] = created.session.tracks;
    // Amyr votes twice, an anonymous browser once: two people, three votes.
    toggleVote({ sessionId: created.session.id, trackId: first.id, accountId: amyr.id });
    toggleVote({ sessionId: created.session.id, trackId: second.id, accountId: amyr.id });
    castAnonymousVote({ sessionId: created.session.id, trackId: first.id, voterId: "anon-voter-01" });

    let current = getSession(created.session.id)!;
    expect(current.totalVotes).toBe(3);
    expect(current.guestCount).toBe(2);
    expect(current.voters).toEqual([
      { name: "Amyr", avatarUrl: null },
      { name: null, avatarUrl: null },
    ]);
    expect(JSON.stringify(current.voters)).not.toContain("anon-voter-01");

    for (let index = 0; index < roomVoterPreviewLimit + 3; index += 1) {
      castAnonymousVote({ sessionId: created.session.id, trackId: second.id, voterId: `anon-voter-1${index}` });
    }
    current = getSession(created.session.id)!;
    expect(current.guestCount).toBe(roomVoterPreviewLimit + 5);
    expect(current.voters).toHaveLength(roomVoterPreviewLimit);
    expect(current.voters[0]).toEqual({ name: "Amyr", avatarUrl: null });
  });

  it("caps the faces per row and leaves the rest to the count", () => {
    const host = account("+32470000093", "Host");
    const created = room(host.id);
    const target = created.session.tracks[0].id;
    for (let index = 0; index < voterPreviewLimit + 2; index += 1) {
      castAnonymousVote({ sessionId: created.session.id, trackId: target, voterId: `v-${index}` });
    }
    const track = getSession(created.session.id)!.tracks.find((item) => item.id === target)!;
    expect(track.votes).toBe(voterPreviewLimit + 2);
    expect(track.voters).toHaveLength(voterPreviewLimit);
  });

  it("persists accounts, rooms, and votes after reopening SQLite", () => {
    const host = account("+32470000018", "Persistent Host");
    const guest = account("+32470000019", "Persistent Guest");
    const created = room(host.id);
    toggleVote({
      sessionId: created.session.id,
      trackId: created.session.tracks[2].id,
      accountId: guest.id,
    });

    const path = testDatabase.path;
    closeDatabase();
    process.env.SQLITE_PATH = path;

    const restored = getSession(created.session.id, guest.id);
    expect(restored?.totalVotes).toBe(1);
    expect(restored?.tracks[0].title).toBe("Third");
    expect(restored?.votedTrackIds).toEqual([created.session.tracks[2].id]);
  });

  it("enforces host ownership and removes ended or expired rooms", () => {
    const host = account("+32470000020", "Host");
    const guest = account("+32470000021", "Guest");
    const created = room(host.id);

    expect(
      endSession({
        sessionId: created.session.id,
        hostKey: created.hostKey,
        accountId: guest.id,
      }),
    ).toBe("forbidden");
    expect(getActiveHostSession(host.id)?.session.id).toBe(created.session.id);
    expect(
      endSession({
        sessionId: created.session.id,
        hostKey: created.hostKey,
        accountId: host.id,
      }),
    ).toBe("ended");
    expect(getSession(created.session.id)).toBeNull();

    const expiring = room(host.id, "expiring-room");
    getDatabase()
      .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", expiring.session.id);
    expect(getSession(expiring.session.id)).toBeNull();
    expect(
      toggleVote({
        sessionId: expiring.session.id,
        trackId: expiring.session.tracks[0].id,
        accountId: guest.id,
      }),
    ).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
  deletePreviews: vi.fn(),
}));

vi.mock("@/lib/r2", () => ({
  deletePreviews: storageMocks.deletePreviews,
}));

import { runCleanup } from "@/lib/cleanup";
import { getDatabase } from "@/lib/db";
import { setupTestDatabase } from "./helpers/database";

setupTestDatabase();

const hour = 60 * 60 * 1000;
const now = new Date("2026-06-01T12:00:00.000Z");
const ago = (hours: number) =>
  new Date(now.getTime() - hours * hour).toISOString();
const ahead = (hours: number) =>
  new Date(now.getTime() + hours * hour).toISOString();

function seedAccount(id: string, phone: string) {
  getDatabase()
    .prepare(
      `INSERT INTO accounts (id, phone, pseudonym, auth_token, created_at, updated_at)
       VALUES (?, ?, 'Name', ?, ?, ?)`,
    )
    .run(id, phone, `token-${id}`, ago(1000), ago(1000));
}

function seedRoom(input: {
  id: string;
  createdAt: string;
  expiresAt: string;
  endedAt?: string | null;
}) {
  getDatabase()
    .prepare(
      `INSERT INTO sessions
        (id, name, venue, host_account_id, host_key, revision, created_at, expires_at, ended_at)
       VALUES (?, 'Room', '', 'host', ?, 0, ?, ?, ?)`,
    )
    .run(
      input.id,
      `key-${input.id}`,
      input.createdAt,
      input.expiresAt,
      input.endedAt ?? null,
    );
}

function seedUpload(objectKey: string, createdAt: string) {
  getDatabase()
    .prepare(
      `INSERT INTO audio_uploads (object_key, account_id, original_name, request_id, created_at)
       VALUES (?, 'host', 'song.mp3', NULL, ?)`,
    )
    .run(objectKey, createdAt);
}

function seedTrack(input: {
  id: string;
  sessionId: string;
  previewKey?: string | null;
}) {
  getDatabase()
    .prepare(
      `INSERT INTO tracks (id, session_id, title, artist, position, preview_key)
       VALUES (?, ?, 'Title', 'Artist', 0, ?)`,
    )
    .run(input.id, input.sessionId, input.previewKey ?? null);
}

function seedVote(trackId: string, sessionId: string, accountId: string) {
  getDatabase()
    .prepare(
      `INSERT INTO votes (track_id, session_id, account_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(trackId, sessionId, accountId, ago(100));
}

function count(table: string) {
  return (
    getDatabase().prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as {
      total: number;
    }
  ).total;
}

function deletesEverything() {
  storageMocks.deletePreviews.mockImplementation(async (keys: string[]) => ({
    deleted: keys,
    failed: [],
  }));
}

describe("cleanup", () => {
  beforeEach(() => {
    seedAccount("host", "+32470000900");
    seedAccount("voter", "+32470000901");
    deletesEverything();
  });

  it("leaves a live room and its preview completely alone", async () => {
    seedRoom({ id: "LIVE01", createdAt: ago(2), expiresAt: ahead(22) });
    // Deliberately older than the upload grace period: only the "still
    // referenced by a track" guard should be keeping this object alive.
    seedUpload("previews/host/live.mp3", ago(48));
    seedTrack({ id: "t-live", sessionId: "LIVE01", previewKey: "previews/host/live.mp3" });
    seedVote("t-live", "LIVE01", "voter");

    const summary = await runCleanup({ now });

    expect(summary).toMatchObject({
      closedRooms: 0,
      deletedRooms: 0,
      deletedObjects: 0,
      deletedUploadRecords: 0,
    });
    expect(storageMocks.deletePreviews).not.toHaveBeenCalled();
    expect(count("sessions")).toBe(1);
    expect(count("tracks")).toBe(1);
    expect(count("votes")).toBe(1);
    expect(count("audio_uploads")).toBe(1);
  });

  it("reclaims a room past retention with its tracks, votes and preview", async () => {
    seedRoom({ id: "OLD001", createdAt: ago(24 * 30), expiresAt: ago(24 * 29) });
    seedUpload("previews/host/old.mp3", ago(24 * 30));
    seedTrack({ id: "t-old", sessionId: "OLD001", previewKey: "previews/host/old.mp3" });
    seedVote("t-old", "OLD001", "voter");

    const summary = await runCleanup({ now });

    expect(summary).toMatchObject({
      deletedRooms: 1,
      deletedTracks: 1,
      deletedVotes: 1,
      deletedObjects: 1,
      deletedUploadRecords: 1,
      retriedObjects: 0,
      storageSkipped: false,
    });
    expect(storageMocks.deletePreviews).toHaveBeenCalledWith([
      "previews/host/old.mp3",
    ]);
    expect(count("sessions")).toBe(0);
    expect(count("tracks")).toBe(0);
    expect(count("votes")).toBe(0);
    expect(count("audio_uploads")).toBe(0);
  });

  it("keeps a room that ended recently", async () => {
    seedRoom({
      id: "RECENT",
      createdAt: ago(30),
      expiresAt: ahead(1),
      endedAt: ago(2),
    });
    seedUpload("previews/host/recent.mp3", ago(30));
    seedTrack({ id: "t-recent", sessionId: "RECENT", previewKey: "previews/host/recent.mp3" });

    const summary = await runCleanup({ now });

    expect(summary.deletedRooms).toBe(0);
    expect(count("sessions")).toBe(1);
    expect(count("audio_uploads")).toBe(1);
    expect(storageMocks.deletePreviews).not.toHaveBeenCalled();
  });

  it("closes a room whose expiry passed without deleting it yet", async () => {
    seedRoom({ id: "JUSTUP", createdAt: ago(25), expiresAt: ago(1) });

    const summary = await runCleanup({ now });

    expect(summary).toMatchObject({ closedRooms: 1, deletedRooms: 0 });
    expect(
      (
        getDatabase()
          .prepare("SELECT ended_at FROM sessions WHERE id = 'JUSTUP'")
          .get() as { ended_at: string | null }
      ).ended_at,
    ).toBe(now.toISOString());
  });

  it("keeps an unattached upload inside the grace period", async () => {
    seedUpload("previews/host/midsetup.mp3", ago(2));

    const summary = await runCleanup({ now });

    expect(summary.deletedUploadRecords).toBe(0);
    expect(storageMocks.deletePreviews).not.toHaveBeenCalled();
    expect(count("audio_uploads")).toBe(1);
  });

  it("removes an unattached upload once the grace period passes", async () => {
    seedUpload("previews/host/abandoned.mp3", ago(48));

    const summary = await runCleanup({ now });

    expect(summary).toMatchObject({
      deletedObjects: 1,
      deletedUploadRecords: 1,
    });
    expect(count("audio_uploads")).toBe(0);
  });

  it("keeps the row when R2 refuses to delete the object", async () => {
    seedUpload("previews/host/stuck.mp3", ago(48));
    storageMocks.deletePreviews.mockResolvedValue({
      deleted: [],
      failed: ["previews/host/stuck.mp3"],
    });

    const summary = await runCleanup({ now });

    expect(summary).toMatchObject({
      deletedObjects: 0,
      retriedObjects: 1,
      deletedUploadRecords: 0,
    });
    // The row is the only record of the key, so losing it would orphan the object.
    expect(count("audio_uploads")).toBe(1);
  });

  it("forgets only the objects R2 confirmed, keeping the rest for a retry", async () => {
    seedUpload("previews/host/gone.mp3", ago(48));
    seedUpload("previews/host/stuck.mp3", ago(48));
    storageMocks.deletePreviews.mockResolvedValue({
      deleted: ["previews/host/gone.mp3"],
      failed: ["previews/host/stuck.mp3"],
    });

    const summary = await runCleanup({ now });

    expect(summary).toMatchObject({
      deletedObjects: 1,
      retriedObjects: 1,
      deletedUploadRecords: 1,
    });
    const remaining = getDatabase()
      .prepare("SELECT object_key FROM audio_uploads")
      .all() as Array<{ object_key: string }>;
    expect(remaining.map((row) => row.object_key)).toEqual([
      "previews/host/stuck.mp3",
    ]);
  });

  it("still reclaims rooms when R2 is not configured", async () => {
    seedRoom({ id: "NOCRED", createdAt: ago(24 * 30), expiresAt: ago(24 * 29) });
    seedUpload("previews/host/nocred.mp3", ago(24 * 30));
    seedTrack({ id: "t-nc", sessionId: "NOCRED", previewKey: "previews/host/nocred.mp3" });
    storageMocks.deletePreviews.mockRejectedValue(
      new Error("R2 credentials are incomplete."),
    );

    const summary = await runCleanup({ now });

    expect(summary).toMatchObject({
      deletedRooms: 1,
      storageSkipped: true,
      retriedObjects: 1,
      deletedUploadRecords: 0,
    });
    expect(count("sessions")).toBe(0);
    expect(count("audio_uploads")).toBe(1);
  });

  it("never reclaims a preview a library still points at", async () => {
    // The regression this guards: catalogue entries have no tracks row until a
    // DJ uses one, so the orphan sweep would have deleted every library preview
    // a day after it was uploaded, quietly emptying the catalogue.
    getDatabase()
      .prepare(
        "INSERT INTO libraries (id, name, description, created_at, updated_at) VALUES ('lib','L','',?,?)",
      )
      .run(ago(200), ago(200));
    seedUpload("previews/host/catalogue.mp3", ago(96));
    getDatabase()
      .prepare(
        `INSERT INTO library_tracks
          (id, library_id, title, artist, preview_key, contributed_by, created_at)
         VALUES ('lt1','lib','Song','Artist','previews/host/catalogue.mp3','host',?)`,
      )
      .run(ago(96));

    const summary = await runCleanup({ now });

    expect(summary).toMatchObject({ deletedObjects: 0, deletedUploadRecords: 0 });
    expect(storageMocks.deletePreviews).not.toHaveBeenCalled();
    expect(count("audio_uploads")).toBe(1);
  });

  it("reclaims the preview once the library entry is gone", async () => {
    getDatabase()
      .prepare(
        "INSERT INTO libraries (id, name, description, created_at, updated_at) VALUES ('lib2','L','',?,?)",
      )
      .run(ago(200), ago(200));
    seedUpload("previews/host/dropped.mp3", ago(96));
    getDatabase()
      .prepare(
        `INSERT INTO library_tracks
          (id, library_id, title, artist, preview_key, contributed_by, created_at)
         VALUES ('lt2','lib2','Song','Artist','previews/host/dropped.mp3','host',?)`,
      )
      .run(ago(96));
    getDatabase().prepare("DELETE FROM library_tracks WHERE id = 'lt2'").run();

    const summary = await runCleanup({ now });

    expect(summary).toMatchObject({ deletedObjects: 1, deletedUploadRecords: 1 });
    expect(count("audio_uploads")).toBe(0);
  });

  it("prunes stale account creation requests", async () => {
    getDatabase()
      .prepare(
        `INSERT INTO account_creation_requests (request_id, voter_id, account_id, created_at)
         VALUES ('stale', 'voter-a', 'host', ?), ('fresh', 'voter-b', 'host', ?)`,
      )
      .run(ago(48), ago(1));

    const summary = await runCleanup({ now });

    expect(summary.deletedAccountRequests).toBe(1);
    expect(count("account_creation_requests")).toBe(1);
  });

  it("is a no-op when run again", async () => {
    seedRoom({ id: "OLD002", createdAt: ago(24 * 30), expiresAt: ago(24 * 29) });
    seedUpload("previews/host/twice.mp3", ago(24 * 30));
    seedTrack({ id: "t-twice", sessionId: "OLD002", previewKey: "previews/host/twice.mp3" });

    await runCleanup({ now });
    storageMocks.deletePreviews.mockClear();
    const second = await runCleanup({ now });

    expect(second).toMatchObject({
      closedRooms: 0,
      deletedRooms: 0,
      deletedObjects: 0,
      deletedUploadRecords: 0,
    });
    expect(storageMocks.deletePreviews).not.toHaveBeenCalled();
  });
});

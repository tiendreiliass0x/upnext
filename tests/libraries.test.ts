import { describe, expect, it } from "vitest";
import { createAccount } from "@/lib/accounts";
import { getDatabase } from "@/lib/db";
import {
  addLibraryTrack,
  createLibrary,
  deleteLibrary,
  deleteLibraryTrack,
  getLibraryTrackPreviewKey,
  listLibraries,
  listLibraryTracks,
} from "@/lib/libraries";
import { createSession, registerAudioUpload } from "@/lib/sessions";
import { setupTestDatabase } from "./helpers/database";

setupTestDatabase();

function account(phone: string) {
  return createAccount({ phone, pseudonym: "Person" });
}

function upload(key: string, accountId: string) {
  registerAudioUpload({
    objectKey: key,
    accountId,
    originalName: "song.mp3",
    requestId: null,
  });
  return key;
}

describe("libraries", () => {
  it("lists libraries by name with their track counts", () => {
    const admin = account("+32470001001");
    const house = createLibrary({ name: "Deep House", description: "late" });
    createLibrary({ name: "Afro", description: "" });
    addLibraryTrack({
      libraryId: house.id,
      title: "One",
      artist: "A",
      previewKey: null,
      contributedBy: admin.id,
    });

    const all = listLibraries();
    expect(all.map((l) => l.name)).toEqual(["Afro", "Deep House"]);
    expect(all.find((l) => l.name === "Deep House")?.trackCount).toBe(1);
    expect(all.find((l) => l.name === "Afro")?.trackCount).toBe(0);
  });

  it("refuses a preview key that no upload backs", () => {
    const library = createLibrary({ name: "L", description: "" });
    expect(
      addLibraryTrack({
        libraryId: library.id,
        title: "Guessed",
        artist: "A",
        previewKey: "previews/someone-else/made-up.mp3",
        contributedBy: null,
      }),
    ).toBe("unknown_preview");
  });

  it("refuses a track for a library that does not exist", () => {
    expect(
      addLibraryTrack({
        libraryId: "missing",
        title: "T",
        artist: "A",
        previewKey: null,
        contributedBy: null,
      }),
    ).toBeNull();
  });

  it("searches title and artist, treating wildcards as literal text", () => {
    const library = createLibrary({ name: "L", description: "" });
    for (const [title, artist] of [
      ["Sunrise", "Kora"],
      ["100% Proof", "Vega"],
      ["Night Drive", "Sunrise Collective"],
    ]) {
      addLibraryTrack({
        libraryId: library.id,
        title,
        artist,
        previewKey: null,
        contributedBy: null,
      });
    }

    expect(
      listLibraryTracks({ libraryId: library.id, query: "sunrise" }).map((t) => t.title),
    ).toEqual(["Night Drive", "Sunrise"]);
    // A bare % must match the one title literally containing it, not all three.
    expect(
      listLibraryTracks({ libraryId: library.id, query: "%" }).map((t) => t.title),
    ).toEqual(["100% Proof"]);
    expect(
      listLibraryTracks({ libraryId: library.id, query: "100%" }).map((t) => t.title),
    ).toEqual(["100% Proof"]);
  });

  it("cascades tracks when a library is deleted", () => {
    const library = createLibrary({ name: "L", description: "" });
    const added = addLibraryTrack({
      libraryId: library.id,
      title: "T",
      artist: "A",
      previewKey: null,
      contributedBy: null,
    });
    expect(typeof added).toBe("object");

    expect(deleteLibrary(library.id)).toBe(1);
    expect(
      (
        getDatabase().prepare("SELECT COUNT(*) AS c FROM library_tracks").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });

  it("exposes a preview only while the entry has one", () => {
    const owner = account("+32470001002");
    const library = createLibrary({ name: "L", description: "" });
    const key = upload("previews/owner/a.mp3", owner.id);
    const track = addLibraryTrack({
      libraryId: library.id,
      title: "T",
      artist: "A",
      previewKey: key,
      contributedBy: owner.id,
    });
    if (typeof track !== "object" || track === null) throw new Error("not added");

    expect(track.previewUrl).toBe(
      `/api/library-tracks/${encodeURIComponent(track.id)}/preview`,
    );
    expect(getLibraryTrackPreviewKey(track.id)).toBe(key);
    deleteLibraryTrack(track.id);
    expect(getLibraryTrackPreviewKey(track.id)).toBeNull();
  });
});

describe("library previews are usable across accounts", () => {
  it("lets a DJ open a room with a song another account uploaded", () => {
    // The regression this guards: createSession used to require the caller to
    // own the upload, and stored an unusable key as NULL, so a catalogue song
    // silently became a track with no audio.
    const curator = account("+32470001010");
    const dj = account("+32470001011");
    const library = createLibrary({ name: "House", description: "" });
    const key = upload("previews/curator/track.mp3", curator.id);
    addLibraryTrack({
      libraryId: library.id,
      title: "Curated",
      artist: "Curator",
      previewKey: key,
      contributedBy: curator.id,
    });

    const room = createSession({
      name: "Night",
      venue: "V",
      accountId: dj.id,
      requestId: null,
      tracks: [{ title: "Curated", artist: "Curator", previewKey: key }],
    });

    expect(room.session.tracks[0].previewUrl).not.toBeNull();
  });

  it("still refuses a preview that is neither owned nor in any library", () => {
    const stranger = account("+32470001020");
    const dj = account("+32470001021");
    const key = upload("previews/stranger/private.mp3", stranger.id);

    const room = createSession({
      name: "Night",
      venue: "V",
      accountId: dj.id,
      requestId: null,
      tracks: [{ title: "Borrowed", artist: "X", previewKey: key }],
    });

    expect(room.session.tracks[0].previewUrl).toBeNull();
  });
});

describe("contributing to a library", () => {
  it("lets a DJ contribute only their own uploads", () => {
    const owner = account("+32470100001");
    const stranger = account("+32470100002");
    const library = createLibrary({ name: "L", description: "" });
    upload("previews/owner/mine.mp3", owner.id);

    expect(
      addLibraryTrack({
        libraryId: library.id,
        title: "Laundered",
        artist: "A",
        previewKey: "previews/owner/mine.mp3",
        contributedBy: stranger.id,
      }),
    ).toBe("unknown_preview");

    expect(
      addLibraryTrack({
        libraryId: library.id,
        title: "Mine",
        artist: "A",
        previewKey: "previews/owner/mine.mp3",
        contributedBy: owner.id,
      }),
    ).toMatchObject({ title: "Mine" });
  });

  it("lets an admin catalogue any upload", () => {
    const owner = account("+32470100003");
    const library = createLibrary({ name: "L", description: "" });
    upload("previews/owner/theirs.mp3", owner.id);

    expect(
      addLibraryTrack({
        libraryId: library.id,
        title: "Curated",
        artist: "A",
        previewKey: "previews/owner/theirs.mp3",
        contributedBy: null,
      }),
    ).toMatchObject({ title: "Curated" });
  });
});

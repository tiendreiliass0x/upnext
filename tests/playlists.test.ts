import { describe, expect, it } from "vitest";
import { createAccount } from "@/lib/accounts";
import { getDatabase } from "@/lib/db";
import { addLibraryTrack, createLibrary, deleteLibraryTrack } from "@/lib/libraries";
import {
  addTrackToPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listPlaylistTracks,
  listPlaylists,
  removeTrackFromPlaylist,
} from "@/lib/playlists";
import { setupTestDatabase } from "./helpers/database";

setupTestDatabase();

function dj(phone: string) {
  return createAccount({ phone, pseudonym: "DJ" });
}

function catalogueTrack(libraryId: string, title: string) {
  const added = addLibraryTrack({
    libraryId,
    title,
    artist: "Artist",
    previewKey: null,
    contributedBy: null,
  });
  if (typeof added !== "object" || added === null) throw new Error("not added");
  return added;
}

describe("playlists", () => {
  it("keeps one DJ's playlists out of another's reach", () => {
    const mine = dj("+32470003001");
    const theirs = dj("+32470003002");
    const playlist = createPlaylist({ accountId: mine.id, name: "Warm up" });

    expect(listPlaylists(theirs.id)).toEqual([]);
    expect(getPlaylist(playlist.id, theirs.id)).toBeNull();
    expect(listPlaylistTracks(playlist.id, theirs.id)).toEqual([]);
    expect(deletePlaylist(playlist.id, theirs.id)).toBe(0);
    // Still intact for the owner.
    expect(getPlaylist(playlist.id, mine.id)?.name).toBe("Warm up");
  });

  it("refuses to add to a playlist the caller does not own", () => {
    const mine = dj("+32470003003");
    const theirs = dj("+32470003004");
    const library = createLibrary({ name: "L", description: "" });
    const track = catalogueTrack(library.id, "Song");
    const playlist = createPlaylist({ accountId: mine.id, name: "Mine" });

    expect(
      addTrackToPlaylist({
        playlistId: playlist.id,
        accountId: theirs.id,
        libraryTrackId: track.id,
      }),
    ).toBe("no_playlist");
    expect(
      removeTrackFromPlaylist({
        playlistId: playlist.id,
        accountId: theirs.id,
        libraryTrackId: track.id,
      }),
    ).toBe(0);
  });

  it("appends in order and reports the count", () => {
    const owner = dj("+32470003005");
    const library = createLibrary({ name: "L", description: "" });
    const playlist = createPlaylist({ accountId: owner.id, name: "Set" });
    for (const title of ["First", "Second", "Third"]) {
      expect(
        addTrackToPlaylist({
          playlistId: playlist.id,
          accountId: owner.id,
          libraryTrackId: catalogueTrack(library.id, title).id,
        }),
      ).toBe("added");
    }

    expect(listPlaylistTracks(playlist.id, owner.id).map((t) => t.title)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
    expect(getPlaylist(playlist.id, owner.id)?.trackCount).toBe(3);
  });

  it("treats adding the same song twice as a no-op", () => {
    const owner = dj("+32470003006");
    const library = createLibrary({ name: "L", description: "" });
    const track = catalogueTrack(library.id, "Once");
    const playlist = createPlaylist({ accountId: owner.id, name: "Set" });

    expect(
      addTrackToPlaylist({ playlistId: playlist.id, accountId: owner.id, libraryTrackId: track.id }),
    ).toBe("added");
    expect(
      addTrackToPlaylist({ playlistId: playlist.id, accountId: owner.id, libraryTrackId: track.id }),
    ).toBe("already_present");
    expect(listPlaylistTracks(playlist.id, owner.id)).toHaveLength(1);
  });

  it("refuses a song that is not in the catalogue", () => {
    const owner = dj("+32470003007");
    const playlist = createPlaylist({ accountId: owner.id, name: "Set" });
    expect(
      addTrackToPlaylist({
        playlistId: playlist.id,
        accountId: owner.id,
        libraryTrackId: "not-a-real-track",
      }),
    ).toBe("no_track");
  });

  it("drops a song from every playlist when the admin removes it", () => {
    // Removal is the moderation lever, so it has to reach playlists too.
    const owner = dj("+32470003008");
    const library = createLibrary({ name: "L", description: "" });
    const track = catalogueTrack(library.id, "Pulled");
    const playlist = createPlaylist({ accountId: owner.id, name: "Set" });
    addTrackToPlaylist({ playlistId: playlist.id, accountId: owner.id, libraryTrackId: track.id });
    expect(listPlaylistTracks(playlist.id, owner.id)).toHaveLength(1);

    deleteLibraryTrack(track.id);

    expect(listPlaylistTracks(playlist.id, owner.id)).toEqual([]);
    expect(getPlaylist(playlist.id, owner.id)?.trackCount).toBe(0);
  });

  it("cascades its tracks when the playlist itself is deleted", () => {
    const owner = dj("+32470003009");
    const library = createLibrary({ name: "L", description: "" });
    const playlist = createPlaylist({ accountId: owner.id, name: "Set" });
    addTrackToPlaylist({
      playlistId: playlist.id,
      accountId: owner.id,
      libraryTrackId: catalogueTrack(library.id, "Gone").id,
    });

    expect(deletePlaylist(playlist.id, owner.id)).toBe(1);
    expect(
      (getDatabase().prepare("SELECT COUNT(*) AS c FROM playlist_tracks").get() as { c: number }).c,
    ).toBe(0);
  });
});

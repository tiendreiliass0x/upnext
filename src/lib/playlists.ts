import { getDatabase } from "@/lib/db";
import type { LibraryTrack } from "@/lib/libraries";

export type Playlist = {
  id: string;
  name: string;
  trackCount: number;
  createdAt: string;
};

export type PlaylistTrack = LibraryTrack & {
  libraryName: string;
  position: number;
};

type PlaylistRow = {
  id: string;
  name: string;
  created_at: string;
  track_count: number;
};

function toPlaylist(row: PlaylistRow): Playlist {
  return {
    id: row.id,
    name: row.name,
    trackCount: row.track_count,
    createdAt: row.created_at,
  };
}

// Every other DJ-writable collection here is bounded (library tracks 500,
// catalogue 200, session tracks 200). Without caps one token could grow a
// playlist list until the correlated COUNT(*) per row stalls the event loop.
export const maximumPlaylistsPerAccount = 100;
export const maximumPlaylistTracks = 500;

const playlistColumns = `p.id, p.name, p.created_at,
  (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = p.id) AS track_count`;

export function listPlaylists(
  accountId: string,
  options: { unbounded?: boolean } = {},
): Playlist[] {
  return (
    getDatabase()
      .prepare(
        `SELECT ${playlistColumns} FROM playlists p
         WHERE p.account_id = ?
         ORDER BY p.created_at DESC
         LIMIT ?`,
      )
      .all(accountId, options.unbounded ? -1 : maximumPlaylistsPerAccount) as PlaylistRow[]
  ).map(toPlaylist);
}

/** Scoped by account everywhere, so one DJ's id cannot reach another's list. */
export function getPlaylist(id: string, accountId: string) {
  const row = getDatabase()
    .prepare(
      `SELECT ${playlistColumns} FROM playlists p
       WHERE p.id = ? AND p.account_id = ?`,
    )
    .get(id, accountId) as PlaylistRow | undefined;
  return row ? toPlaylist(row) : null;
}

export const playlistLimitMessage =
  "You have reached the playlist limit. Delete one first.";

/** Throws with playlistLimitMessage once the account holds the maximum. */
export function createPlaylist(input: {
  accountId: string;
  name: string;
  bypassLimit?: boolean;
}): Playlist {
  const database = getDatabase();
  return database
    .transaction(() => {
      const owned = (
        database
          .prepare("SELECT COUNT(*) AS count FROM playlists WHERE account_id = ?")
          .get(input.accountId) as { count: number }
      ).count;
      if (!input.bypassLimit && owned >= maximumPlaylistsPerAccount) {
        throw new Error(playlistLimitMessage);
      }

      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      database
        .prepare(
          `INSERT INTO playlists (id, account_id, name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, input.accountId, input.name, now, now);
      return getPlaylist(id, input.accountId) as Playlist;
    })
    .immediate();
}

export function deletePlaylist(id: string, accountId: string) {
  return getDatabase()
    .prepare("DELETE FROM playlists WHERE id = ? AND account_id = ?")
    .run(id, accountId).changes;
}

export function listPlaylistTracks(
  id: string,
  accountId: string,
  options: { unbounded?: boolean } = {},
): PlaylistTrack[] {
  const rows = getDatabase()
    .prepare(
      `SELECT t.id, t.library_id, t.title, t.artist, t.preview_key,
              t.contributed_by, t.created_at, l.name AS library_name, pt.position
       FROM playlist_tracks pt
       JOIN playlists p ON p.id = pt.playlist_id AND p.account_id = ?
       JOIN library_tracks t ON t.id = pt.library_track_id
       JOIN libraries l ON l.id = t.library_id
       WHERE pt.playlist_id = ?
       ORDER BY pt.position ASC
       LIMIT ?`,
    )
    .all(accountId, id, options.unbounded ? -1 : maximumPlaylistTracks) as Array<{
    id: string;
    library_id: string;
    title: string;
    artist: string;
    preview_key: string | null;
    contributed_by: string | null;
    created_at: string;
    library_name: string;
    position: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    libraryId: row.library_id,
    title: row.title,
    artist: row.artist,
    previewUrl: row.preview_key
      ? `/api/library-tracks/${encodeURIComponent(row.id)}/preview`
      : null,
    libraryPreviewKey: row.preview_key,
    contributedBy: row.contributed_by,
    createdAt: row.created_at,
    libraryName: row.library_name,
    position: row.position,
  }));
}

export type AddTrackResult =
  | "added"
  | "already_present"
  | "no_playlist"
  | "no_track"
  | "full";

export function addTrackToPlaylist(input: {
  playlistId: string;
  accountId: string;
  libraryTrackId: string;
  bypassLimit?: boolean;
}): AddTrackResult {
  const database = getDatabase();
  return database
    .transaction(() => {
      const owned = database
        .prepare("SELECT 1 FROM playlists WHERE id = ? AND account_id = ?")
        .get(input.playlistId, input.accountId);
      if (!owned) return "no_playlist" as const;

      const track = database
        .prepare("SELECT 1 FROM library_tracks WHERE id = ?")
        .get(input.libraryTrackId);
      if (!track) return "no_track" as const;

      const existing = database
        .prepare(
          "SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND library_track_id = ?",
        )
        .get(input.playlistId, input.libraryTrackId);
      if (existing) return "already_present" as const;

      // Append. Computed inside the transaction so two adds cannot collide on
      // the same position, and so the cap cannot be raced past.
      const { count, next } = database
        .prepare(
          `SELECT COUNT(*) AS count, COALESCE(MAX(position), -1) + 1 AS next
           FROM playlist_tracks WHERE playlist_id = ?`,
        )
        .get(input.playlistId) as { count: number; next: number };
      if (!input.bypassLimit && count >= maximumPlaylistTracks) return "full" as const;

      database
        .prepare(
          `INSERT INTO playlist_tracks
            (playlist_id, library_track_id, position, added_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          input.playlistId,
          input.libraryTrackId,
          next,
          new Date().toISOString(),
        );
      return "added" as const;
    })
    .immediate();
}

export type AddLibraryResult = {
  status: "added" | "no_playlist" | "no_library" | "full";
  added: number;
};

/** Append one library by reference, without copying its tracks or audio. */
export function addLibraryToPlaylist(input: {
  playlistId: string;
  accountId: string;
  libraryId: string;
  bypassLimit?: boolean;
}): AddLibraryResult {
  const database = getDatabase();
  return database
    .transaction(() => {
      const owned = database
        .prepare("SELECT 1 FROM playlists WHERE id = ? AND account_id = ?")
        .get(input.playlistId, input.accountId);
      if (!owned) return { status: "no_playlist" as const, added: 0 };

      const library = database
        .prepare("SELECT 1 FROM libraries WHERE id = ?")
        .get(input.libraryId);
      if (!library) return { status: "no_library" as const, added: 0 };

      const { count, next } = database
        .prepare(
          `SELECT COUNT(*) AS count, COALESCE(MAX(position), -1) + 1 AS next
           FROM playlist_tracks WHERE playlist_id = ?`,
        )
        .get(input.playlistId) as { count: number; next: number };
      const available = input.bypassLimit
        ? -1
        : Math.max(maximumPlaylistTracks - count, 0);
      const tracks = database
        .prepare(
          `SELECT id FROM library_tracks t
           WHERE library_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM playlist_tracks pt
               WHERE pt.playlist_id = ? AND pt.library_track_id = t.id
             )
           ORDER BY title COLLATE NOCASE ASC
           LIMIT ?`,
        )
        .all(input.libraryId, input.playlistId, available) as Array<{ id: string }>;

      const insert = database.prepare(
        `INSERT INTO playlist_tracks
          (playlist_id, library_track_id, position, added_at)
         VALUES (?, ?, ?, ?)`,
      );
      const addedAt = new Date().toISOString();
      tracks.forEach((track, index) => {
        insert.run(input.playlistId, track.id, next + index, addedAt);
      });

      const hasMore =
        !input.bypassLimit &&
        Boolean(
          database
            .prepare(
              `SELECT 1 FROM library_tracks t
               WHERE library_id = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM playlist_tracks pt
                   WHERE pt.playlist_id = ? AND pt.library_track_id = t.id
                 )
               LIMIT 1`,
            )
            .get(input.libraryId, input.playlistId),
        );
      return {
        status: hasMore ? ("full" as const) : ("added" as const),
        added: tracks.length,
      };
    })
    .immediate();
}

export function removeTrackFromPlaylist(input: {
  playlistId: string;
  accountId: string;
  libraryTrackId: string;
}) {
  const database = getDatabase();
  return database
    .transaction(() => {
      const owned = database
        .prepare("SELECT 1 FROM playlists WHERE id = ? AND account_id = ?")
        .get(input.playlistId, input.accountId);
      if (!owned) return 0;
      return database
        .prepare(
          "DELETE FROM playlist_tracks WHERE playlist_id = ? AND library_track_id = ?",
        )
        .run(input.playlistId, input.libraryTrackId).changes;
    })
    .immediate();
}

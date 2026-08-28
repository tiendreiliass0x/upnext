import { getDatabase } from "@/lib/db";

export type Library = {
  id: string;
  name: string;
  description: string;
  trackCount: number;
  createdAt: string;
};

export type LibraryTrack = {
  id: string;
  libraryId: string;
  title: string;
  artist: string;
  previewUrl: string | null;
  // The DJ reuses this when opening a room, so the song never re-uploads.
  libraryPreviewKey: string | null;
  contributedBy: string | null;
  createdAt: string;
};

type LibraryRow = {
  id: string;
  name: string;
  description: string;
  created_at: string;
  track_count: number;
};

type LibraryTrackRow = {
  id: string;
  library_id: string;
  title: string;
  artist: string;
  preview_key: string | null;
  contributed_by: string | null;
  created_at: string;
};

function toLibrary(row: LibraryRow): Library {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    trackCount: row.track_count,
    createdAt: row.created_at,
  };
}

function toLibraryTrack(row: LibraryTrackRow): LibraryTrack {
  return {
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
  };
}

export function listLibraries(): Library[] {
  return (
    getDatabase()
      .prepare(
        `SELECT l.id, l.name, l.description, l.created_at,
                COUNT(t.id) AS track_count
         FROM libraries l
         LEFT JOIN library_tracks t ON t.library_id = l.id
         GROUP BY l.id
         ORDER BY l.name COLLATE NOCASE ASC`,
      )
      .all() as LibraryRow[]
  ).map(toLibrary);
}

export function getLibrary(id: string) {
  const row = getDatabase()
    .prepare(
      `SELECT l.id, l.name, l.description, l.created_at,
              COUNT(t.id) AS track_count
       FROM libraries l
       LEFT JOIN library_tracks t ON t.library_id = l.id
       WHERE l.id = ?
       GROUP BY l.id`,
    )
    .get(id) as LibraryRow | undefined;
  return row ? toLibrary(row) : null;
}

export function createLibrary(input: { name: string; description: string }) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  getDatabase()
    .prepare(
      `INSERT INTO libraries (id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, input.name, input.description, now, now);
  return getLibrary(id) as Library;
}

export function deleteLibrary(id: string) {
  // library_tracks cascade. The uploads they referenced become unreferenced and
  // are reclaimed by the next cleanup run once past the grace period.
  return getDatabase().prepare("DELETE FROM libraries WHERE id = ?").run(id)
    .changes;
}

export function listLibraryTracks(input: {
  libraryId: string;
  query?: string;
  limit?: number;
}): LibraryTrack[] {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const search = input.query?.trim() ?? "";
  const database = getDatabase();

  if (!search) {
    return (
      database
        .prepare(
          `SELECT id, library_id, title, artist, preview_key, contributed_by, created_at
           FROM library_tracks WHERE library_id = ?
           ORDER BY title COLLATE NOCASE ASC LIMIT ?`,
        )
        .all(input.libraryId, limit) as LibraryTrackRow[]
    ).map(toLibraryTrack);
  }

  // LIKE with escaped wildcards: a search for "100%" must not match everything.
  const pattern = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return (
    database
      .prepare(
        `SELECT id, library_id, title, artist, preview_key, contributed_by, created_at
         FROM library_tracks
         WHERE library_id = ?
           AND (title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\')
         ORDER BY title COLLATE NOCASE ASC LIMIT ?`,
      )
      .all(input.libraryId, pattern, pattern, limit) as LibraryTrackRow[]
  ).map(toLibraryTrack);
}

export function addLibraryTrack(input: {
  libraryId: string;
  title: string;
  artist: string;
  previewKey: string | null;
  contributedBy: string | null;
}) {
  const database = getDatabase();
  const id = crypto.randomUUID();
  const inserted = database
    .transaction(() => {
      const library = database
        .prepare("SELECT 1 FROM libraries WHERE id = ?")
        .get(input.libraryId);
      if (!library) return null;

      // A caller could otherwise point a catalogue entry at any object key it
      // guessed; only a real upload row may be referenced. A DJ may only
      // contribute their own uploads: a library entry makes an object usable
      // by everyone, so this is the one path that could launder a stranger's
      // upload into the shared pool. Admins (no contributor) curate freely.
      if (input.previewKey) {
        const upload = database
          .prepare(
            `SELECT 1 FROM audio_uploads
             WHERE object_key = ? AND (? IS NULL OR account_id = ?)`,
          )
          .get(input.previewKey, input.contributedBy, input.contributedBy);
        if (!upload) return "unknown_preview" as const;
      }

      database
        .prepare(
          `INSERT INTO library_tracks
            (id, library_id, title, artist, preview_key, contributed_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.libraryId,
          input.title,
          input.artist,
          input.previewKey,
          input.contributedBy,
          new Date().toISOString(),
        );
      return id;
    })
    .immediate();

  if (inserted === null || inserted === "unknown_preview") return inserted;
  const row = database
    .prepare(
      `SELECT id, library_id, title, artist, preview_key, contributed_by, created_at
       FROM library_tracks WHERE id = ?`,
    )
    .get(id) as LibraryTrackRow;
  return toLibraryTrack(row);
}

export function deleteLibraryTrack(id: string) {
  return getDatabase().prepare("DELETE FROM library_tracks WHERE id = ?").run(id)
    .changes;
}

export function getLibraryTrackPreviewKey(id: string) {
  const row = getDatabase()
    .prepare(
      "SELECT preview_key FROM library_tracks WHERE id = ? AND preview_key IS NOT NULL",
    )
    .get(id) as { preview_key: string } | undefined;
  return row?.preview_key ?? null;
}

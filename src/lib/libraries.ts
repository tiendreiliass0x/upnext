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

// LIKE with escaped wildcards: a search for "100%" must match the one title
// containing a percent sign, not the whole catalogue. Shared so both search
// paths escape identically.
function likePattern(search: string) {
  return `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * What an admin listing returns instead of a page.
 *
 * The point of `unbounded` is that the person curating the catalogue sees all
 * of it rather than the first shelf-sized page. A literal `LIMIT -1` reads as
 * that, but SQLite takes it as no limit at all, and every one of those rows is
 * serialised and then given its own list item by the console — which is
 * attached to the admin, the account with the largest catalogue of anyone.
 * High enough to mean "everything" for a real catalogue, finite enough that
 * the page cannot be asked to render an unbounded one.
 */
export const adminListingLimit = 5000;

export function listLibraryTracks(input: {
  libraryId: string;
  query?: string;
  limit?: number;
  unbounded?: boolean;
}): LibraryTrack[] {
  const limit = input.unbounded
    ? adminListingLimit
    : Math.min(Math.max(input.limit ?? 200, 1), 500);
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

  const pattern = likePattern(search);
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

export type CatalogueTrack = LibraryTrack & { libraryName: string };

/**
 * Search every library at once. The picker in the booth scopes to one library
 * because a DJ is building from a chosen set; /play searches the whole
 * catalogue because you are looking for a song, not a shelf.
 */
export function searchCatalogue(input: {
  query?: string;
  limit?: number;
  unbounded?: boolean;
}): CatalogueTrack[] {
  const limit = input.unbounded
    ? adminListingLimit
    : Math.min(Math.max(input.limit ?? 100, 1), 200);
  const search = input.query?.trim() ?? "";
  const database = getDatabase();
  const columns = `t.id, t.library_id, t.title, t.artist, t.preview_key,
                   t.contributed_by, t.created_at, l.name AS library_name`;

  const rows = (
    search
      ? database
          .prepare(
            `SELECT ${columns}
             FROM library_tracks t JOIN libraries l ON l.id = t.library_id
             WHERE t.title LIKE ? ESCAPE '\\' OR t.artist LIKE ? ESCAPE '\\'
             ORDER BY t.title COLLATE NOCASE ASC LIMIT ?`,
          )
          .all(likePattern(search), likePattern(search), limit)
      : database
          .prepare(
            `SELECT ${columns}
             FROM library_tracks t JOIN libraries l ON l.id = t.library_id
             ORDER BY t.created_at DESC LIMIT ?`,
          )
          .all(limit)
  ) as Array<LibraryTrackRow & { library_name: string }>;

  return rows.map((row) => ({
    ...toLibraryTrack(row),
    libraryName: row.library_name,
  }));
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

        // A retry after the attachment response was lost must reuse the row
        // that already landed, not create a second copy of the same upload.
        const existing = database
          .prepare(
            `SELECT id FROM library_tracks
             WHERE library_id = ? AND preview_key = ?`,
          )
          .get(input.libraryId, input.previewKey) as { id: string } | undefined;
        // Said, not assumed: the caller cannot tell a retry that landed from
        // a re-add of the same audio under a corrected title, and reporting
        // the second as added would claim an edit that never happened.
        if (existing) return { id: existing.id, created: false };
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
      return { id, created: true };
    })
    .immediate();

  if (inserted === null || inserted === "unknown_preview") return inserted;
  const row = database
    .prepare(
      `SELECT id, library_id, title, artist, preview_key, contributed_by, created_at
       FROM library_tracks WHERE id = ?`,
    )
    .get(inserted.id) as LibraryTrackRow;
  // The track as every other caller expects it, with one extra field saying
  // whether this call is what put it there.
  return { ...toLibraryTrack(row), created: inserted.created };
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

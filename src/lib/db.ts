import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

type DatabaseRegistry = typeof globalThis & {
  djBoothDatabase?: Database.Database;
};

const registry = globalThis as DatabaseRegistry;

export function getDatabase() {
  if (registry.djBoothDatabase) return registry.djBoothDatabase;

  const databasePath =
    process.env.SQLITE_PATH ?? join(process.cwd(), "data", "dj-booth.sqlite");
  mkdirSync(dirname(databasePath), { recursive: true });

  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL UNIQUE,
      pseudonym TEXT NOT NULL,
      auth_token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voter_accounts (
      voter_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_creation_requests (
      request_id TEXT PRIMARY KEY,
      voter_id TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      venue TEXT NOT NULL DEFAULT '',
      host_account_id TEXT NOT NULL REFERENCES accounts(id),
      host_key TEXT NOT NULL UNIQUE,
      request_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audio_uploads (
      object_key TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      original_name TEXT NOT NULL,
      request_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS libraries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS library_tracks (
      id TEXT PRIMARY KEY,
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      preview_key TEXT REFERENCES audio_uploads(object_key),
      contributed_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Points at the catalogue rather than copying it, so an admin removing a
    -- song removes it from every playlist that held it. That keeps removal
    -- meaningful as the moderation lever.
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      library_track_id TEXT NOT NULL REFERENCES library_tracks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (playlist_id, library_track_id)
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      position INTEGER NOT NULL,
      preview_key TEXT REFERENCES audio_uploads(object_key)
    );

    CREATE TABLE IF NOT EXISTS votes (
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (track_id, account_id)
    );

    CREATE TABLE IF NOT EXISTS anonymous_votes (
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      voter_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, voter_id)
    );

    CREATE INDEX IF NOT EXISTS sessions_host_idx
      ON sessions(host_account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS tracks_session_idx
      ON tracks(session_id, position);
    -- Plain, not partial: SQLite only consults a full index when enforcing the
    -- audio_uploads foreign key as cleanup removes retired previews.
    CREATE INDEX IF NOT EXISTS tracks_preview_key_idx
      ON tracks(preview_key);
    CREATE INDEX IF NOT EXISTS library_tracks_library_idx
      ON library_tracks(library_id, title);
    -- Plain, like tracks_preview_key_idx: cleanup asks whether a library still
    -- points at an upload, and SQLite needs a full index for the foreign key.
    CREATE INDEX IF NOT EXISTS library_tracks_preview_idx
      ON library_tracks(preview_key);
    CREATE INDEX IF NOT EXISTS library_tracks_contributor_idx
      ON library_tracks(contributed_by);
    CREATE INDEX IF NOT EXISTS playlists_account_idx
      ON playlists(account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS playlist_tracks_order_idx
      ON playlist_tracks(playlist_id, position);
    -- Plain index on the child key so removing a catalogue song does not scan.
    CREATE INDEX IF NOT EXISTS playlist_tracks_library_idx
      ON playlist_tracks(library_track_id);
    CREATE INDEX IF NOT EXISTS votes_session_idx
      ON votes(session_id);
    CREATE INDEX IF NOT EXISTS anonymous_votes_track_idx
      ON anonymous_votes(track_id);
    CREATE INDEX IF NOT EXISTS voter_accounts_account_idx
      ON voter_accounts(account_id);
    CREATE INDEX IF NOT EXISTS account_creation_requests_account_idx
      ON account_creation_requests(account_id);

    DELETE FROM votes
    WHERE NOT EXISTS (
      SELECT 1 FROM tracks
      WHERE id = votes.track_id AND session_id = votes.session_id
    );
    DELETE FROM anonymous_votes
    WHERE NOT EXISTS (
      SELECT 1 FROM tracks
      WHERE id = anonymous_votes.track_id
        AND session_id = anonymous_votes.session_id
    );

    CREATE TRIGGER IF NOT EXISTS votes_track_session_insert
    BEFORE INSERT ON votes
    WHEN NOT EXISTS (
      SELECT 1 FROM tracks
      WHERE id = NEW.track_id AND session_id = NEW.session_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'vote track/session mismatch');
    END;

    CREATE TRIGGER IF NOT EXISTS votes_track_session_update
    BEFORE UPDATE OF track_id, session_id ON votes
    WHEN NOT EXISTS (
      SELECT 1 FROM tracks
      WHERE id = NEW.track_id AND session_id = NEW.session_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'vote track/session mismatch');
    END;

    CREATE TRIGGER IF NOT EXISTS anonymous_votes_track_session_insert
    BEFORE INSERT ON anonymous_votes
    WHEN NOT EXISTS (
      SELECT 1 FROM tracks
      WHERE id = NEW.track_id AND session_id = NEW.session_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'vote track/session mismatch');
    END;

    CREATE TRIGGER IF NOT EXISTS anonymous_votes_track_session_update
    BEFORE UPDATE OF track_id, session_id ON anonymous_votes
    WHEN NOT EXISTS (
      SELECT 1 FROM tracks
      WHERE id = NEW.track_id AND session_id = NEW.session_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'vote track/session mismatch');
    END;

    CREATE TRIGGER IF NOT EXISTS tracks_voted_session_update
    BEFORE UPDATE OF session_id ON tracks
    WHEN NEW.session_id != OLD.session_id AND (
      EXISTS (SELECT 1 FROM votes WHERE track_id = OLD.id)
      OR EXISTS (SELECT 1 FROM anonymous_votes WHERE track_id = OLD.id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'voted track session cannot change');
    END;
  `);

  const sessionColumns = database.pragma("table_info(sessions)") as Array<{
    name: string;
  }>;
  if (!sessionColumns.some((column) => column.name === "request_id")) {
    database.exec("ALTER TABLE sessions ADD COLUMN request_id TEXT");
  }
  const uploadColumns = database.pragma("table_info(audio_uploads)") as Array<{
    name: string;
  }>;
  if (!uploadColumns.some((column) => column.name === "request_id")) {
    database.exec("ALTER TABLE audio_uploads ADD COLUMN request_id TEXT");
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS sessions_host_request_idx
      ON sessions(host_account_id, request_id)
      WHERE request_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uploads_account_request_idx
      ON audio_uploads(account_id, request_id)
      WHERE request_id IS NOT NULL;
  `);

  registry.djBoothDatabase = database;
  return database;
}

export function closeDatabase() {
  if (!registry.djBoothDatabase) return;
  registry.djBoothDatabase.close();
  delete registry.djBoothDatabase;
}

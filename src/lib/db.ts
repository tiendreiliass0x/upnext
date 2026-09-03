import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

type DatabaseRegistry = typeof globalThis & {
  djBoothDatabase?: Database.Database;
};

const registry = globalThis as DatabaseRegistry;
let initializedDatabase: Database.Database | undefined;

export function getDatabase() {
  const cached = registry.djBoothDatabase;
  if (cached && initializedDatabase === cached) return cached;

  let database = cached;
  if (!database) {
    const databasePath =
      process.env.SQLITE_PATH ?? join(process.cwd(), "data", "dj-booth.sqlite");
    mkdirSync(dirname(databasePath), { recursive: true });
    database = new Database(databasePath);
  }

  // Next dev keeps this connection on globalThis across module reloads. The
  // module-local marker resets, so a surviving connection still runs any new
  // idempotent schema setup before updated queries can reach it.
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
      cash_app_handle TEXT,
      venmo_handle TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      keep_open INTEGER NOT NULL DEFAULT 0 CHECK (keep_open IN (0, 1)),
      ended_at TEXT,
      -- What the DJ has on: a soft pointer into tracks, cleared with the row.
      now_playing_track_id TEXT,
      now_playing_started_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audio_uploads (
      object_key TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      original_name TEXT NOT NULL,
      request_id TEXT,
      created_at TEXT NOT NULL,
      -- Summed per account to enforce the storage quota.
      size_bytes INTEGER NOT NULL DEFAULT 0
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
      -- Historical name: this now points at the full stored song, not a clip.
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
      preview_key TEXT REFERENCES audio_uploads(object_key),
      -- Set when the DJ plays it; a played song leaves the ballot.
      played_at TEXT
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

    -- A DJ's standing grant against their own account on a music service.
    -- The tokens are sealed (src/lib/secrets.ts): unlike an auth_token or a
    -- host_key, these are not capabilities this app issued and can revoke by
    -- deleting the row, so the row is not allowed to be the whole secret.
    CREATE TABLE IF NOT EXISTS provider_connections (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      permalink_url TEXT NOT NULL DEFAULT '',
      scopes TEXT NOT NULL DEFAULT '',
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      access_expires_at TEXT,
      -- SoundCloud refresh tokens are single use, so two requests refreshing
      -- at once would spend the same token twice and kill the connection.
      -- This column is the claim that serialises them.
      refreshing_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- One in-flight OAuth handshake. The provider redirects back with no
    -- Authorization header, so this row is what binds the callback to the
    -- account that started it, and its unguessability is the CSRF defence.
    -- Single use and short lived: it is deleted as it is read.
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
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
    CREATE UNIQUE INDEX IF NOT EXISTS provider_connections_account_idx
      ON provider_connections(account_id, provider);
    CREATE INDEX IF NOT EXISTS oauth_states_account_idx
      ON oauth_states(account_id);
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
  if (!sessionColumns.some((column) => column.name === "now_playing_track_id")) {
    database.exec(`
      ALTER TABLE sessions ADD COLUMN now_playing_track_id TEXT;
      ALTER TABLE sessions ADD COLUMN now_playing_started_at TEXT;
    `);
  }
  if (!sessionColumns.some((column) => column.name === "cash_app_handle")) {
    database.exec("ALTER TABLE sessions ADD COLUMN cash_app_handle TEXT");
  }
  if (!sessionColumns.some((column) => column.name === "venmo_handle")) {
    database.exec("ALTER TABLE sessions ADD COLUMN venmo_handle TEXT");
  }
  if (!sessionColumns.some((column) => column.name === "keep_open")) {
    database.exec(
      "ALTER TABLE sessions ADD COLUMN keep_open INTEGER NOT NULL DEFAULT 0 CHECK (keep_open IN (0, 1))",
    );
  }
  const trackColumns = database.pragma("table_info(tracks)") as Array<{
    name: string;
  }>;
  if (!trackColumns.some((column) => column.name === "played_at")) {
    database.exec("ALTER TABLE tracks ADD COLUMN played_at TEXT");
  }
  // A row imported from a connected service. The provider track ID is the
  // only durable handle: stream URLs expire well inside a room's 24 hours, so
  // they are resolved per request and never stored. uploader_name and
  // permalink_url are not decoration -- SoundCloud's API terms require the
  // uploader credited and a visible backlink wherever a track is shown.
  if (!trackColumns.some((column) => column.name === "provider")) {
    database.exec(`
      ALTER TABLE tracks ADD COLUMN provider TEXT;
      ALTER TABLE tracks ADD COLUMN provider_track_id TEXT;
      ALTER TABLE tracks ADD COLUMN artwork_url TEXT;
      ALTER TABLE tracks ADD COLUMN permalink_url TEXT;
      ALTER TABLE tracks ADD COLUMN uploader_name TEXT;
      ALTER TABLE tracks ADD COLUMN duration_ms INTEGER;
    `);
  }
  const uploadColumns = database.pragma("table_info(audio_uploads)") as Array<{
    name: string;
  }>;
  if (!uploadColumns.some((column) => column.name === "request_id")) {
    database.exec("ALTER TABLE audio_uploads ADD COLUMN request_id TEXT");
  }
  if (!uploadColumns.some((column) => column.name === "size_bytes")) {
    database.exec(
      "ALTER TABLE audio_uploads ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0",
    );
  }
  // Objects under previews/ are 30-second clips from before full songs were
  // stored. In the catalogue they now look like whole songs and stop short,
  // so the claim is dropped: the row shows "no audio" until it is re-uploaded,
  // and cleanup reaps the clip once nothing else holds it.
  database.exec(
    "UPDATE library_tracks SET preview_key = NULL WHERE preview_key LIKE 'previews/%'",
  );
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS sessions_host_request_idx
      ON sessions(host_account_id, request_id)
      WHERE request_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uploads_account_request_idx
      ON audio_uploads(account_id, request_id)
      WHERE request_id IS NOT NULL;
  `);

  registry.djBoothDatabase = database;
  initializedDatabase = database;
  return database;
}

export function closeDatabase() {
  if (!registry.djBoothDatabase) return;
  registry.djBoothDatabase.close();
  delete registry.djBoothDatabase;
  initializedDatabase = undefined;
}

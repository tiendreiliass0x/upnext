import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase } from "@/lib/db";
import { setupTestDatabase } from "./helpers/database";

const testDatabase = setupTestDatabase();

describe("database migrations", () => {
  it("migrates a cached connection after the database module reloads", async () => {
    const cached = getDatabase();
    cached.exec(`
      ALTER TABLE sessions DROP COLUMN cash_app_handle;
      ALTER TABLE sessions DROP COLUMN venmo_handle;
      ALTER TABLE sessions DROP COLUMN keep_open;
    `);

    // Next dev preserves the connection on globalThis while replacing this
    // module. The replacement must initialize that connection before queries
    // compiled against the new schema run.
    vi.resetModules();
    const reloaded = await import("@/lib/db");
    const migrated = reloaded.getDatabase();
    const columns = migrated.pragma("table_info(sessions)") as Array<{
      name: string;
    }>;

    expect(columns.map(({ name }) => name)).toContain("cash_app_handle");
    expect(columns.map(({ name }) => name)).toContain("venmo_handle");
    expect(columns.map(({ name }) => name)).toContain("keep_open");
  });

  it("adds anonymous voter storage without losing legacy account data", () => {
    closeDatabase();
    const legacy = new Database(testDatabase.path);
    legacy.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL UNIQUE,
        pseudonym TEXT NOT NULL,
        auth_token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        venue TEXT NOT NULL DEFAULT '',
        host_account_id TEXT NOT NULL REFERENCES accounts(id),
        host_key TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE TABLE audio_uploads (
        object_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        original_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE tracks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        position INTEGER NOT NULL,
        preview_key TEXT REFERENCES audio_uploads(object_key)
      );
      CREATE TABLE votes (
        track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (track_id, account_id)
      );
      INSERT INTO accounts
        (id, phone, pseudonym, auth_token, created_at, updated_at)
      VALUES
        ('legacy-account', '+32470000999', 'Legacy DJ', 'legacy-token',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO sessions
        (id, name, venue, host_account_id, host_key, revision, created_at,
         expires_at, ended_at)
      VALUES
        ('ROOMA', 'Room A', '', 'legacy-account', 'host-key-a', 0,
         '2026-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', NULL),
        ('ROOMB', 'Room B', '', 'legacy-account', 'host-key-b', 0,
         '2026-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', NULL);
      INSERT INTO tracks (id, session_id, title, artist, position, preview_key)
      VALUES ('track-a', 'ROOMA', 'Track A', 'Artist', 0, NULL);
      INSERT INTO votes (track_id, session_id, account_id, created_at)
      VALUES
        ('track-a', 'ROOMB', 'legacy-account', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const migrated = getDatabase();
    const tables = migrated
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN
           ('account_creation_requests', 'anonymous_votes', 'voter_accounts')`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name).sort()).toEqual([
      "account_creation_requests",
      "anonymous_votes",
      "voter_accounts",
    ]);
    expect(
      migrated
        .prepare("SELECT pseudonym FROM accounts WHERE id = 'legacy-account'")
        .get(),
    ).toEqual({ pseudonym: "Legacy DJ" });
    const sessionColumns = migrated.pragma("table_info(sessions)") as Array<{
      name: string;
    }>;
    const uploadColumns = migrated.pragma("table_info(audio_uploads)") as Array<{
      name: string;
    }>;
    expect(sessionColumns.map(({ name }) => name)).toContain("request_id");
    expect(sessionColumns.map(({ name }) => name)).toContain("cash_app_handle");
    expect(sessionColumns.map(({ name }) => name)).toContain("venmo_handle");
    expect(sessionColumns.map(({ name }) => name)).toContain("keep_open");
    expect(
      migrated
        .prepare(
          "SELECT cash_app_handle, venmo_handle, keep_open FROM sessions WHERE id = 'ROOMA'",
        )
        .get(),
    ).toEqual({ cash_app_handle: null, venmo_handle: null, keep_open: 0 });
    expect(uploadColumns.map(({ name }) => name)).toContain("request_id");
    expect(
      migrated.prepare("SELECT COUNT(*) AS count FROM votes").get(),
    ).toEqual({ count: 0 });

    // The profile columns arrive together — the check that guards them only
    // asks about avatar_key, so a half-applied pair would leave every account
    // read naming a column that is not there.
    const accountColumns = migrated.pragma("table_info(accounts)") as Array<{
      name: string;
    }>;
    expect(accountColumns.map(({ name }) => name)).toContain("avatar_key");
    expect(accountColumns.map(({ name }) => name)).toContain("tagline");
    expect(
      migrated
        .prepare("SELECT avatar_key, tagline FROM accounts WHERE id = 'legacy-account'")
        .get(),
    ).toEqual({ avatar_key: null, tagline: "" });
  });

  it("leaves an already-migrated database alone", () => {
    const first = getDatabase();
    first
      .prepare(
        `INSERT INTO accounts
          (id, phone, pseudonym, auth_token, avatar_key, tagline, created_at, updated_at)
         VALUES ('kept', '+32470000998', 'Kept', 'kept-token',
                 'avatars/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png', 'Vinyl only',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    closeDatabase();

    // Booting again must not re-run the ALTERs or reset what they added.
    expect(
      getDatabase()
        .prepare("SELECT avatar_key, tagline FROM accounts WHERE id = 'kept'")
        .get(),
    ).toEqual({
      avatar_key: "avatars/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png",
      tagline: "Vinyl only",
    });
  });
});

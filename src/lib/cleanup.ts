import { getDatabase } from "@/lib/db";
import { deletePreviews } from "@/lib/r2";

const hour = 60 * 60 * 1000;
const defaultRoomRetentionHours = 24 * 7;
const defaultUploadGraceHours = 24;
const accountRequestRetentionHours = 24;

export type CleanupSummary = {
  closedRooms: number;
  deletedRooms: number;
  deletedTracks: number;
  deletedVotes: number;
  deletedObjects: number;
  retriedObjects: number;
  deletedUploadRecords: number;
  deletedAccountRequests: number;
  storageSkipped: boolean;
};

function readHours(name: string, fallback: number) {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

/**
 * Reclaims rooms that stopped being live long enough ago that nobody is coming
 * back for them, then removes the R2 previews those rooms were holding open.
 *
 * Safe to run concurrently with the app and safe to interrupt: an object is
 * always removed from R2 before its database row, so a crash in between leaves
 * a row that the next run retries rather than an object nothing points at.
 */
export async function runCleanup(options: { now?: Date } = {}) {
  const database = getDatabase();
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const roomCutoff = new Date(
    now.getTime() - readHours("CLEANUP_ROOM_RETENTION_HOURS", defaultRoomRetentionHours) * hour,
  ).toISOString();
  const uploadCutoff = new Date(
    now.getTime() - readHours("CLEANUP_UPLOAD_GRACE_HOURS", defaultUploadGraceHours) * hour,
  ).toISOString();
  const accountRequestCutoff = new Date(
    now.getTime() - accountRequestRetentionHours * hour,
  ).toISOString();

  const summary: CleanupSummary = {
    closedRooms: 0,
    deletedRooms: 0,
    deletedTracks: 0,
    deletedVotes: 0,
    deletedObjects: 0,
    retriedObjects: 0,
    deletedUploadRecords: 0,
    deletedAccountRequests: 0,
    storageSkipped: false,
  };

  // A room is past retention once it has been closed for long enough, or once
  // its own expiry is that far behind us. The second half matters for rooms
  // that expired without anyone ending them, which is the normal case.
  const retiredRooms = `
    (ended_at IS NOT NULL AND ended_at <= @roomCutoff)
    OR expires_at <= @roomCutoff
  `;

  database
    .transaction(() => {
      summary.closedRooms = database
        .prepare(
          `UPDATE sessions SET ended_at = @nowIso
           WHERE ended_at IS NULL AND expires_at <= @nowIso`,
        )
        .run({ nowIso }).changes;

      const countIn = (table: string) =>
        (
          database
            .prepare(
              `SELECT COUNT(*) AS total FROM ${table}
               WHERE session_id IN (SELECT id FROM sessions WHERE ${retiredRooms})`,
            )
            .get({ roomCutoff }) as { total: number }
        ).total;

      summary.deletedTracks = countIn("tracks");
      summary.deletedVotes =
        countIn("votes") + countIn("anonymous_votes");
      // tracks, votes and anonymous_votes all cascade from sessions.
      summary.deletedRooms = database
        .prepare(`DELETE FROM sessions WHERE ${retiredRooms}`)
        .run({ roomCutoff }).changes;

      summary.deletedAccountRequests = database
        .prepare(
          "DELETE FROM account_creation_requests WHERE created_at <= @accountRequestCutoff",
        )
        .run({ accountRequestCutoff }).changes;
    })
    .immediate();

  // Anything no track points at any more, past the grace period that covers a
  // DJ who uploaded previews and has not opened the room yet.
  const retiredUploads = (
    database
      .prepare(
        `SELECT object_key FROM audio_uploads
         WHERE created_at <= @uploadCutoff
           AND NOT EXISTS (
             SELECT 1 FROM tracks WHERE preview_key = audio_uploads.object_key
           )`,
      )
      .all({ uploadCutoff }) as Array<{ object_key: string }>
  ).map((row) => row.object_key);

  if (retiredUploads.length === 0) return summary;

  let deleted: string[] = [];
  let failed: string[] = [];
  try {
    ({ deleted, failed } = await deletePreviews(retiredUploads));
  } catch {
    // Without credentials the rooms are still reclaimed; the objects wait.
    summary.storageSkipped = true;
    summary.retriedObjects = retiredUploads.length;
    return summary;
  }

  summary.deletedObjects = deleted.length;
  summary.retriedObjects = failed.length;

  if (deleted.length > 0) {
    const forget = database.prepare(
      "DELETE FROM audio_uploads WHERE object_key = ?",
    );
    summary.deletedUploadRecords = database
      .transaction(() =>
        deleted.reduce((total, key) => total + forget.run(key).changes, 0),
      )
      .immediate();
  }

  return summary;
}

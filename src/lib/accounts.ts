import { getDatabase } from "@/lib/db";
import { avatarUrlFor } from "@/lib/profile";

export type PublicAccount = {
  id: string;
  pseudonym: string;
  phoneLast4: string;
  /** Where to fetch the profile picture, or null for the initial bubble. */
  avatarUrl: string | null;
  tagline: string;
};

export type StoredAccount = PublicAccount & {
  phone: string;
  authToken: string;
  avatarKey: string | null;
};

export type AccountStatus = {
  id: string;
  pseudonym: string;
  phoneLast4: string;
  createdAt: string;
  updatedAt: string;
  uploadCount: number;
  storageBytes: number;
  libraryTrackCount: number;
  uploadsNotInLibrary: number;
  playlistCount: number;
  activeRoomCount: number;
};

type AccountStatusRow = {
  id: string;
  phone: string;
  pseudonym: string;
  created_at: string;
  updated_at: string;
  upload_count: number;
  storage_bytes: number;
  library_track_count: number;
  uploads_not_in_library: number;
  playlist_count: number;
  active_room_count: number;
};

type AccountRow = {
  id: string;
  phone: string;
  pseudonym: string;
  auth_token: string;
  avatar_key: string | null;
  tagline: string;
};

const accountColumnsSql =
  "id, phone, pseudonym, auth_token, avatar_key, tagline";

export function normalizePhone(phone: string) {
  let digits = phone.replace(/\D/g, "");
  if (phone.trim().startsWith("00")) digits = digits.slice(2);
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export function listAccountStatuses(): AccountStatus[] {
  const now = new Date().toISOString();
  const rows = getDatabase()
    .prepare(
      `SELECT a.id, a.phone, a.pseudonym, a.created_at, a.updated_at,
              (SELECT COUNT(*) FROM audio_uploads u
               WHERE u.account_id = a.id) AS upload_count,
              COALESCE((SELECT SUM(u.size_bytes) FROM audio_uploads u
                        WHERE u.account_id = a.id), 0) AS storage_bytes,
              (SELECT COUNT(*) FROM library_tracks t
               WHERE t.contributed_by = a.id) AS library_track_count,
              (SELECT COUNT(*) FROM audio_uploads u
               WHERE u.account_id = a.id
                 AND NOT EXISTS (
                   SELECT 1 FROM library_tracks t WHERE t.preview_key = u.object_key
                 )) AS uploads_not_in_library,
              (SELECT COUNT(*) FROM playlists p
               WHERE p.account_id = a.id) AS playlist_count,
              (SELECT COUNT(*) FROM sessions s
               WHERE s.host_account_id = a.id AND s.ended_at IS NULL
                 AND (s.keep_open = 1 OR s.expires_at > ?)) AS active_room_count
       FROM accounts a
       ORDER BY a.created_at DESC`,
    )
    .all(now) as AccountStatusRow[];

  return rows.map((row) => ({
    id: row.id,
    pseudonym: row.pseudonym,
    phoneLast4: row.phone.slice(-4),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    uploadCount: row.upload_count,
    storageBytes: row.storage_bytes,
    libraryTrackCount: row.library_track_count,
    uploadsNotInLibrary: row.uploads_not_in_library,
    playlistCount: row.playlist_count,
    activeRoomCount: row.active_room_count,
  }));
}

function toStoredAccount(row: AccountRow): StoredAccount {
  return {
    id: row.id,
    phone: row.phone,
    phoneLast4: row.phone.slice(-4),
    pseudonym: row.pseudonym,
    authToken: row.auth_token,
    avatarKey: row.avatar_key,
    avatarUrl: avatarUrlFor(row.avatar_key),
    tagline: row.tagline,
  };
}

export function getAccountByPhone(phone: string) {
  const row = getDatabase()
    .prepare(`SELECT ${accountColumnsSql} FROM accounts WHERE phone = ?`)
    .get(phone) as AccountRow | undefined;
  return row ? toStoredAccount(row) : null;
}

export function getAccountByCreationRequest(input: {
  requestId: string;
  voterId: string;
}) {
  const createdAfter = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const row = getDatabase()
    .prepare(
      `SELECT a.id, a.phone, a.pseudonym, a.auth_token, a.avatar_key, a.tagline
       FROM account_creation_requests r
       JOIN accounts a ON a.id = r.account_id
       WHERE r.request_id = ? AND r.voter_id = ? AND r.created_at >= ?`,
    )
    .get(input.requestId, input.voterId, createdAfter) as AccountRow | undefined;
  return row ? toStoredAccount(row) : null;
}

export const voterLinkedElsewhereMessage =
  "This browser voter ID is linked to another account.";

function claimAnonymousVoterInTransaction(
  database: ReturnType<typeof getDatabase>,
  accountId: string,
  voterId: string,
  now: string,
  onLinkedElsewhere: "throw" | "skip" = "throw",
) {
  const linkedAccount = database
    .prepare("SELECT account_id FROM voter_accounts WHERE voter_id = ?")
    .get(voterId) as { account_id: string } | undefined;
  if (linkedAccount && linkedAccount.account_id !== accountId) {
    if (onLinkedElsewhere === "skip") return false;
    throw new Error(voterLinkedElsewhereMessage);
  }
  if (!linkedAccount) {
    database
      .prepare(
        `INSERT INTO voter_accounts (voter_id, account_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(voterId, accountId, now);
  }

  const claimedSessions = database
    .prepare(
      "SELECT DISTINCT session_id FROM anonymous_votes WHERE voter_id = ?",
    )
    .all(voterId) as Array<{ session_id: string }>;
  database
    .prepare(
      `INSERT OR IGNORE INTO votes
        (track_id, session_id, account_id, created_at)
       SELECT track_id, session_id, ?, created_at
       FROM anonymous_votes WHERE voter_id = ?`,
    )
    .run(accountId, voterId);
  database
    .prepare("DELETE FROM anonymous_votes WHERE voter_id = ?")
    .run(voterId);
  const updateRevision = database.prepare(
    "UPDATE sessions SET revision = revision + 1 WHERE id = ?",
  );
  claimedSessions.forEach(({ session_id }) => updateRevision.run(session_id));
  return true;
}

/**
 * Carry a browser's free vote over to an account. A voter ID already linked
 * to another account is either an error ("throw") or, for a login, simply
 * nothing to carry over ("skip"): the account is still logged in, exactly as
 * it would be from a fresh browser. Refusing would lock the second person on
 * a shared phone out for good.
 */
export function claimAnonymousVoter(input: {
  accountId: string;
  voterId: string;
  onLinkedElsewhere?: "throw" | "skip";
}) {
  const database = getDatabase();
  return database
    .transaction(() =>
      claimAnonymousVoterInTransaction(
        database,
        input.accountId,
        input.voterId,
        new Date().toISOString(),
        input.onLinkedElsewhere ?? "throw",
      ),
    )
    .immediate();
}

export function createAccount(input: {
  phone: string;
  pseudonym: string;
  anonymousVoterId?: string | null;
  requestId?: string | null;
}) {
  const database = getDatabase();
  const account: StoredAccount = {
    id: crypto.randomUUID(),
    phone: input.phone,
    phoneLast4: input.phone.slice(-4),
    pseudonym: input.pseudonym,
    authToken: crypto.randomUUID(),
    avatarKey: null,
    avatarUrl: null,
    tagline: "",
  };

  database
    .transaction(() => {
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO accounts
            (id, phone, pseudonym, auth_token, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          account.id,
          account.phone,
          account.pseudonym,
          account.authToken,
          now,
          now,
        );

      if (!input.anonymousVoterId) return;
      // A browser whose voter ID already belongs to someone else (a phone
      // passed around a table) simply has no free vote to carry over. The
      // account is still created, exactly as it would be from a fresh
      // browser; refusing here would lock the second person out for good.
      claimAnonymousVoterInTransaction(
        database,
        account.id,
        input.anonymousVoterId,
        now,
        "skip",
      );
      if (input.requestId) {
        database
          .prepare(
            `INSERT INTO account_creation_requests
              (request_id, voter_id, account_id, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(input.requestId, input.anonymousVoterId, account.id, now);
      }
    })
    .immediate();

  return account;
}

/**
 * Nudge every live room this account is visible in.
 *
 * A profile labels every room this account hosts and rides along on the face
 * stacks of rooms they voted in. Guests poll with a revision-keyed ETag, so
 * without a bump they keep hearing 304 and showing yesterday's name and
 * picture until something else in the room happens to change.
 */
function touchAccountRooms(
  database: ReturnType<typeof getDatabase>,
  accountId: string,
  now: string,
) {
  database
    .prepare(
      `UPDATE sessions SET revision = revision + 1
       WHERE ended_at IS NULL AND (keep_open = 1 OR expires_at > ?)
          AND (
            host_account_id = ?
            OR id IN (SELECT session_id FROM votes WHERE account_id = ?)
          )`,
    )
    .run(now, accountId, accountId);
}

/**
 * Save the parts of a profile that are text. Each field is optional and only
 * what is passed is written, so the picture form and the name form can each
 * send what they touched without reading the rest back first.
 */
export function updateAccountProfile(
  account: StoredAccount,
  changes: { pseudonym?: string; tagline?: string },
): StoredAccount {
  // Only the columns the caller named are written. Filling the others in from
  // the snapshot this request read would make two concurrent edits of
  // different fields undo one another: the second write would carry the first
  // field's pre-edit value back over the top of it.
  const columns: string[] = [];
  const values: string[] = [];
  const updated = { ...account };
  if (changes.pseudonym !== undefined) {
    const pseudonym = changes.pseudonym.trim();
    if (pseudonym !== account.pseudonym) {
      columns.push("pseudonym = ?");
      values.push(pseudonym);
      updated.pseudonym = pseudonym;
    }
  }
  if (changes.tagline !== undefined) {
    const tagline = changes.tagline.trim();
    if (tagline !== account.tagline) {
      columns.push("tagline = ?");
      values.push(tagline);
      updated.tagline = tagline;
    }
  }
  // An empty PATCH, or one that resubmits what is already stored, is not a
  // change. Writing anyway would bump the revision of every live room this
  // account is in and cost each of their guests a full payload on the next
  // poll in place of a 304 — which a caller could repeat at will.
  if (columns.length === 0) return account;

  const database = getDatabase();
  database.transaction(() => {
    const now = new Date().toISOString();
    database
      .prepare(
        `UPDATE accounts SET ${columns.join(", ")}, updated_at = ? WHERE id = ?`,
      )
      .run(...values, now, account.id);
    touchAccountRooms(database, account.id, now);
  })();
  return updated;
}

/**
 * Point the account at a new picture, or at none, and hand back the key it
 * was holding so the caller can delete that object. The swap is a single
 * write, and the old object is removed after it: an object outliving its row
 * for a moment is a wasted byte, whereas a row outliving its object would be
 * a broken picture on every face in the room.
 */
export function setAccountAvatar(
  account: StoredAccount,
  avatarKey: string | null,
): { account: StoredAccount; replacedKey: string | null } {
  const database = getDatabase();
  // The key being replaced is read inside the write, not taken from the
  // snapshot this request arrived with. Two uploads racing would otherwise
  // both name the key they each saw and one of them would go on holding an
  // object nothing points at — and nothing reaps avatars, so it would hold it
  // for good.
  const replacedKey = database
    .transaction(() => {
      const current = database
        .prepare("SELECT avatar_key FROM accounts WHERE id = ?")
        .get(account.id) as { avatar_key: string | null } | undefined;
      const previous = current?.avatar_key ?? null;
      // Nothing to do, and worth saying so: the write would bump the revision
      // of every live room this account is in, costing every guest in them a
      // full payload on their next poll in place of a 304.
      if (previous === avatarKey) return null;
      const now = new Date().toISOString();
      database
        .prepare(
          "UPDATE accounts SET avatar_key = ?, updated_at = ? WHERE id = ?",
        )
        .run(avatarKey, now, account.id);
      touchAccountRooms(database, account.id, now);
      return previous;
    })
    .immediate();

  return {
    account: { ...account, avatarKey, avatarUrl: avatarUrlFor(avatarKey) },
    replacedKey,
  };
}

/**
 * Whether an object key is still the picture of some account.
 *
 * The public avatar route asks before it signs anything. Removing a picture
 * deletes its object, but that delete is best effort — it can fail, and the
 * row is already forgotten by then — so without this check a URL handed out
 * before the removal would keep resolving to the object for as long as the
 * failed delete went unnoticed.
 */
export function avatarKeyIsCurrent(objectKey: string) {
  return Boolean(
    getDatabase()
      .prepare("SELECT 1 FROM accounts WHERE avatar_key = ?")
      .get(objectKey),
  );
}

export function getAccountByToken(token: string) {
  if (!token || token.length > 100) return null;
  const row = getDatabase()
    .prepare(
      `SELECT ${accountColumnsSql} FROM accounts WHERE auth_token = ?`,
    )
    .get(token) as AccountRow | undefined;
  return row ? toStoredAccount(row) : null;
}

export function toPublicAccount(account: StoredAccount): PublicAccount {
  return {
    id: account.id,
    pseudonym: account.pseudonym,
    phoneLast4: account.phoneLast4,
    avatarUrl: account.avatarUrl,
    tagline: account.tagline,
  };
}

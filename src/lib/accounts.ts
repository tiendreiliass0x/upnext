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
       WHERE ended_at IS NULL AND expires_at > ?
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
  const pseudonym =
    changes.pseudonym === undefined
      ? account.pseudonym
      : changes.pseudonym.trim();
  const tagline =
    changes.tagline === undefined ? account.tagline : changes.tagline.trim();
  const database = getDatabase();
  database.transaction(() => {
    const now = new Date().toISOString();
    database
      .prepare(
        "UPDATE accounts SET pseudonym = ?, tagline = ?, updated_at = ? WHERE id = ?",
      )
      .run(pseudonym, tagline, now, account.id);
    touchAccountRooms(database, account.id, now);
  })();
  return { ...account, pseudonym, tagline };
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
  // Nothing to do, and worth saying so: the write would bump the revision of
  // every live room this account is in, costing every guest in them a full
  // payload on their next poll in place of a 304.
  if (account.avatarKey === avatarKey) {
    return { account, replacedKey: null };
  }
  const database = getDatabase();
  database.transaction(() => {
    const now = new Date().toISOString();
    database
      .prepare("UPDATE accounts SET avatar_key = ?, updated_at = ? WHERE id = ?")
      .run(avatarKey, now, account.id);
    touchAccountRooms(database, account.id, now);
  })();
  return {
    account: { ...account, avatarKey, avatarUrl: avatarUrlFor(avatarKey) },
    replacedKey:
      account.avatarKey && account.avatarKey !== avatarKey
        ? account.avatarKey
        : null,
  };
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

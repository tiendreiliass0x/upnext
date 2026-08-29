import { getDatabase } from "@/lib/db";

export type PublicAccount = {
  id: string;
  pseudonym: string;
  phoneLast4: string;
};

export type StoredAccount = PublicAccount & {
  phone: string;
  authToken: string;
};

type AccountRow = {
  id: string;
  phone: string;
  pseudonym: string;
  auth_token: string;
};

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
  };
}

export function getAccountByPhone(phone: string) {
  const row = getDatabase()
    .prepare("SELECT id, phone, pseudonym, auth_token FROM accounts WHERE phone = ?")
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
      `SELECT a.id, a.phone, a.pseudonym, a.auth_token
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

export function claimAnonymousVoter(input: {
  accountId: string;
  voterId: string;
}) {
  const database = getDatabase();
  database
    .transaction(() => {
      claimAnonymousVoterInTransaction(
        database,
        input.accountId,
        input.voterId,
        new Date().toISOString(),
      );
    })
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

export function updateAccountPseudonym(account: StoredAccount, pseudonym: string) {
  const database = getDatabase();
  database.transaction(() => {
    const now = new Date().toISOString();
    database
      .prepare("UPDATE accounts SET pseudonym = ?, updated_at = ? WHERE id = ?")
      .run(pseudonym, now, account.id);
    // The name is on the face stacks of every live room this account has
    // voted in, and guests poll with a revision-keyed ETag: without a bump
    // they would keep hearing 304 and showing the old name until someone
    // else in that room voted.
    database
      .prepare(
        `UPDATE sessions SET revision = revision + 1
         WHERE ended_at IS NULL AND expires_at > ?
           AND id IN (SELECT session_id FROM votes WHERE account_id = ?)`,
      )
      .run(now, account.id);
  })();
  return { ...account, pseudonym };
}

export function getAccountByToken(token: string) {
  if (!token || token.length > 100) return null;
  const row = getDatabase()
    .prepare(
      "SELECT id, phone, pseudonym, auth_token FROM accounts WHERE auth_token = ?",
    )
    .get(token) as AccountRow | undefined;
  return row ? toStoredAccount(row) : null;
}

export function toPublicAccount(account: StoredAccount): PublicAccount {
  return {
    id: account.id,
    pseudonym: account.pseudonym,
    phoneLast4: account.phoneLast4,
  };
}

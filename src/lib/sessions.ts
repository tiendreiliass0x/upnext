import { getDatabase } from "@/lib/db";

export type SessionTrack = {
  id: string;
  title: string;
  artist: string;
  votes: number;
  position: number;
  previewUrl: string | null;
};

export type PublicSession = {
  id: string;
  name: string;
  venue: string;
  createdAt: string;
  revision: number;
  totalVotes: number;
  guestCount: number;
  votedTrackIds: string[];
  anonymousVoteUsed: boolean;
  tracks: SessionTrack[];
};

type SessionRow = {
  id: string;
  name: string;
  venue: string;
  created_at: string;
  expires_at: string;
  ended_at: string | null;
  revision: number;
};

type TrackRow = {
  id: string;
  title: string;
  artist: string;
  position: number;
  preview_key: string | null;
  votes: number;
};

const sessionLifetime = 24 * 60 * 60 * 1000;

function createSessionId() {
  const database = getDatabase();
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";

  do {
    id = Array.from(
      { length: 6 },
      () => alphabet[Math.floor(Math.random() * alphabet.length)],
    ).join("");
  } while (database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id));

  return id;
}

function expireOldSessions() {
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      "UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL AND expires_at <= ?",
    )
    .run(now, now);
}

function getPublicSession(sessionId: string, accountId?: string) {
  const database = getDatabase();
  return database.transaction(() => {
    const session = database
      .prepare(
        `SELECT id, name, venue, created_at, expires_at, ended_at, revision
         FROM sessions
         WHERE id = ? AND ended_at IS NULL AND expires_at > ?`,
      )
      .get(sessionId.toUpperCase(), new Date().toISOString()) as
      | SessionRow
      | undefined;
    if (!session) return null;

    const tracks = database
      .prepare(
        `SELECT t.id, t.title, t.artist, t.position, t.preview_key,
                 COUNT(v.track_id) AS votes
         FROM tracks t
         LEFT JOIN (
           SELECT track_id FROM votes WHERE session_id = ?
           UNION ALL
           SELECT track_id FROM anonymous_votes WHERE session_id = ?
         ) v ON v.track_id = t.id
         WHERE t.session_id = ?
         GROUP BY t.id
         ORDER BY votes DESC, t.position ASC`,
      )
      .all(session.id, session.id, session.id) as TrackRow[];
    const totals = database
      .prepare(
        `SELECT COUNT(*) AS total_votes,
                 COUNT(DISTINCT voter_key) AS guest_count
         FROM (
           SELECT 'account:' || account_id AS voter_key
           FROM votes WHERE session_id = ?
           UNION ALL
           SELECT 'anonymous:' || voter_id AS voter_key
           FROM anonymous_votes WHERE session_id = ?
         )`,
      )
      .get(session.id, session.id) as {
      total_votes: number;
      guest_count: number;
    };
    const votedTrackIds = accountId
      ? (
          database
            .prepare(
              "SELECT track_id FROM votes WHERE session_id = ? AND account_id = ?",
            )
            .all(session.id, accountId) as Array<{ track_id: string }>
        ).map((vote) => vote.track_id)
      : [];

    return {
      id: session.id,
      name: session.name,
      venue: session.venue,
      createdAt: session.created_at,
      revision: session.revision,
      totalVotes: totals.total_votes,
      guestCount: totals.guest_count,
      votedTrackIds,
      anonymousVoteUsed: false,
      tracks: tracks.map((track) => ({
        id: track.id,
        title: track.title,
        artist: track.artist,
        votes: track.votes,
        position: track.position,
        previewUrl: track.preview_key
          ? `/api/tracks/${encodeURIComponent(track.id)}/preview`
          : null,
      })),
    } satisfies PublicSession;
  })();
}

export function createSession(input: {
  name: string;
  venue: string;
  accountId: string;
  requestId?: string | null;
  tracks: Array<{
    title: string;
    artist: string;
    previewKey?: string | null;
  }>;
}) {
  expireOldSessions();
  const database = getDatabase();
  const created = database.transaction(() => {
    if (input.requestId) {
      const existing = database
        .prepare(
          `SELECT id, host_key FROM sessions
           WHERE host_account_id = ? AND request_id = ?`,
        )
        .get(input.accountId, input.requestId) as
        | { id: string; host_key: string }
        | undefined;
      if (existing) {
        return { id: existing.id, hostKey: existing.host_key };
      }
    }

    const id = createSessionId();
    const hostKey = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + sessionLifetime).toISOString();
    database
      .prepare(
        `INSERT INTO sessions
          (id, name, venue, host_account_id, host_key, request_id,
           revision, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.venue,
        input.accountId,
        hostKey,
        input.requestId ?? null,
        createdAt,
        expiresAt,
      );

    // Either the caller uploaded it, or a library offers it to everyone.
    // Without the second clause a DJ picking a catalogue song would silently
    // get a track with no audio, since an unusable key is stored as NULL.
    const canUseUpload = database.prepare(
      `SELECT 1 FROM audio_uploads u
       WHERE u.object_key = ?
         AND (
           u.account_id = ?
           OR EXISTS (
             SELECT 1 FROM library_tracks WHERE preview_key = u.object_key
           )
         )`,
    );
    const insertTrack = database.prepare(
      `INSERT INTO tracks
        (id, session_id, title, artist, position, preview_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    input.tracks.forEach((track, position) => {
      const previewKey =
        track.previewKey && canUseUpload.get(track.previewKey, input.accountId)
          ? track.previewKey
          : null;
      insertTrack.run(
        crypto.randomUUID(),
        id,
        track.title,
        track.artist,
        position,
        previewKey,
      );
    });
    return { id, hostKey };
  }).immediate();

  return {
    session: getPublicSession(created.id, input.accountId) as PublicSession,
    hostKey: created.hostKey,
  };
}

export function getSession(id: string, accountId?: string) {
  return getPublicSession(id, accountId);
}

export function getSessionRevision(id: string) {
  const row = getDatabase()
    .prepare(
      `SELECT id, revision FROM sessions
       WHERE id = ? AND ended_at IS NULL AND expires_at > ?`,
    )
    .get(id.toUpperCase(), new Date().toISOString()) as
    | { id: string; revision: number }
    | undefined;
  return row ?? null;
}

export function getAnonymousSession(id: string, voterId: string) {
  const session = getPublicSession(id);
  if (!session) return null;
  const votedTrackIds = (
    getDatabase()
      .prepare(
        `SELECT track_id FROM anonymous_votes
         WHERE session_id = ? AND voter_id = ?`,
      )
      .all(session.id, voterId) as Array<{ track_id: string }>
  ).map((vote) => vote.track_id);
  const claimed = Boolean(
    getDatabase()
      .prepare("SELECT 1 FROM voter_accounts WHERE voter_id = ?")
      .get(voterId),
  );
  return {
    ...session,
    votedTrackIds,
    anonymousVoteUsed: claimed || votedTrackIds.length > 0,
  };
}

export function getActiveHostSession(accountId: string) {
  const row = getDatabase()
    .prepare(
      `SELECT id, host_key FROM sessions
       WHERE host_account_id = ? AND ended_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(accountId, new Date().toISOString()) as
    | { id: string; host_key: string }
    | undefined;
  if (!row) return null;
  const session = getPublicSession(row.id, accountId);
  if (!session) return null;

  return {
    session,
    hostKey: row.host_key,
  };
}

export function endSession(input: {
  sessionId: string;
  hostKey: string;
  accountId: string;
}) {
  const database = getDatabase();
  return database
    .transaction(() => {
      const now = new Date().toISOString();
      const session = database
        .prepare(
          `SELECT id, host_key, host_account_id FROM sessions
           WHERE id = ? AND ended_at IS NULL AND expires_at > ?`,
        )
        .get(input.sessionId.toUpperCase(), now) as
        | { id: string; host_key: string; host_account_id: string }
        | undefined;
      if (!session) return "not_found" as const;
      if (
        session.host_key !== input.hostKey ||
        session.host_account_id !== input.accountId
      ) {
        return "forbidden" as const;
      }

      database
        .prepare("UPDATE sessions SET ended_at = ? WHERE id = ?")
        .run(now, session.id);
      return "ended" as const;
    })
    .immediate();
}

export function toggleVote(input: {
  sessionId: string;
  trackId: string;
  accountId: string;
  enabled?: boolean;
}) {
  const database = getDatabase();
  const toggled = database
    .transaction(() => {
      const session = database
        .prepare(
          `SELECT id FROM sessions
           WHERE id = ? AND ended_at IS NULL AND expires_at > ?`,
        )
        .get(input.sessionId.toUpperCase(), new Date().toISOString()) as
        | { id: string }
        | undefined;
      if (!session) return null;

      const track = database
        .prepare("SELECT id FROM tracks WHERE id = ? AND session_id = ?")
        .get(input.trackId, session.id) as { id: string } | undefined;
      if (!track) return null;

      const existingVote = database
        .prepare("SELECT 1 FROM votes WHERE track_id = ? AND account_id = ?")
        .get(track.id, input.accountId);
      const voted = input.enabled ?? !existingVote;
      const changed = voted !== Boolean(existingVote);
      if (voted && changed) {
        database
          .prepare(
            `INSERT INTO votes (track_id, session_id, account_id, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(track.id, session.id, input.accountId, new Date().toISOString());
      } else if (changed) {
        database
          .prepare("DELETE FROM votes WHERE track_id = ? AND account_id = ?")
          .run(track.id, input.accountId);
      }
      if (changed) {
        database
          .prepare("UPDATE sessions SET revision = revision + 1 WHERE id = ?")
          .run(session.id);
      }
      return { sessionId: session.id, voted };
    })
    .immediate();
  if (!toggled) return null;

  const session = getPublicSession(toggled.sessionId, input.accountId);
  return session ? { session, voted: toggled.voted } : null;
}

export function castAnonymousVote(input: {
  sessionId: string;
  trackId: string;
  voterId: string;
}) {
  const database = getDatabase();
  const result = database
    .transaction(() => {
      const session = database
        .prepare(
          `SELECT id FROM sessions
           WHERE id = ? AND ended_at IS NULL AND expires_at > ?`,
        )
        .get(input.sessionId.toUpperCase(), new Date().toISOString()) as
        | { id: string }
        | undefined;
      if (!session) return { status: "not_found" as const };

      const track = database
        .prepare("SELECT id FROM tracks WHERE id = ? AND session_id = ?")
        .get(input.trackId, session.id) as { id: string } | undefined;
      if (!track) return { status: "not_found" as const };

      const claimed = database
        .prepare("SELECT 1 FROM voter_accounts WHERE voter_id = ?")
        .get(input.voterId);
      if (claimed) return { status: "phone_required" as const };

      const existing = database
        .prepare(
          `SELECT track_id FROM anonymous_votes
           WHERE session_id = ? AND voter_id = ?`,
        )
        .get(session.id, input.voterId) as { track_id: string } | undefined;
      if (existing) {
        return existing.track_id === track.id
          ? { status: "voted" as const, sessionId: session.id }
          : { status: "phone_required" as const };
      }

      database
        .prepare(
          `INSERT INTO anonymous_votes
            (track_id, session_id, voter_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(track.id, session.id, input.voterId, new Date().toISOString());
      database
        .prepare("UPDATE sessions SET revision = revision + 1 WHERE id = ?")
        .run(session.id);
      return { status: "voted" as const, sessionId: session.id };
    })
    .immediate();

  if (result.status !== "voted") return result;
  const session = getAnonymousSession(result.sessionId, input.voterId);
  return session
    ? { status: "voted" as const, session, voted: true }
    : { status: "not_found" as const };
}

export function registerAudioUpload(input: {
  objectKey: string;
  accountId: string;
  originalName: string;
  requestId?: string | null;
}) {
  getDatabase()
    .prepare(
      `INSERT INTO audio_uploads
        (object_key, account_id, original_name, request_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.objectKey,
      input.accountId,
      input.originalName,
      input.requestId ?? null,
      new Date().toISOString(),
    );
}

export function getAudioUploadByRequest(accountId: string, requestId: string) {
  const row = getDatabase()
    .prepare(
      `SELECT object_key FROM audio_uploads
       WHERE account_id = ? AND request_id = ?`,
    )
    .get(accountId, requestId) as { object_key: string } | undefined;
  return row?.object_key ?? null;
}

export function getTrackPreviewKey(trackId: string) {
  const row = getDatabase()
    .prepare(
      `SELECT t.preview_key
       FROM tracks t
       JOIN sessions s ON s.id = t.session_id
       WHERE t.id = ? AND t.preview_key IS NOT NULL
         AND s.ended_at IS NULL AND s.expires_at > ?`,
    )
    .get(trackId, new Date().toISOString()) as
    | { preview_key: string }
    | undefined;
  return row?.preview_key ?? null;
}

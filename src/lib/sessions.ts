import { getDatabase } from "@/lib/db";

export type SessionTrack = {
  id: string;
  title: string;
  artist: string;
  votes: number;
  position: number;
  previewUrl: string | null;
  playedAt: string | null;
  /** Songs that still have to roll before this one can be voted for again. */
  cooldown: number;
};

export type NowPlaying = {
  trackId: string;
  title: string;
  artist: string;
  previewUrl: string | null;
  startedAt: string;
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
  nowPlaying: NowPlaying | null;
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
  now_playing_track_id: string | null;
  now_playing_started_at: string | null;
};

type TrackRow = {
  id: string;
  title: string;
  artist: string;
  position: number;
  preview_key: string | null;
  played_at: string | null;
  cooldown: number;
  votes: number;
};

/**
 * A played song is not gone for good — people may want it again — but it sits
 * out until this many other songs have rolled. Its votes are spent when it
 * plays, so it has to be voted back up rather than returning on old votes.
 */
export const cooldownSongs = 2;

export class CooldownError extends Error {
  constructor(public songsRemaining: number) {
    super(cooldownMessage(songsRemaining));
  }
}

export function cooldownMessage(songsRemaining: number) {
  const count = songsRemaining === 1 ? "one more song has" : "two more songs have";
  return `Cooldown — try again after ${count} rolled.`;
}

// Songs played after this one, capped at the cooldown. Only tracks in the
// same room count, and only plays later than this track's own last play. A
// room smaller than the cooldown shortens it to what can actually roll, so a
// two-track room cools for one song and a one-track room never does — the
// message "try again after N more songs" is then always something that can
// come true.
const trackCooldownSql = `
  CASE WHEN t.played_at IS NULL THEN 0 ELSE MAX(0, MIN(${cooldownSongs},
    (SELECT COUNT(*) FROM tracks n WHERE n.session_id = t.session_id) - 1
  ) - (
    SELECT COUNT(*) FROM tracks o
    WHERE o.session_id = t.session_id
      AND o.played_at IS NOT NULL AND o.played_at > t.played_at
  )) END`;

// Among open songs: most live votes first, then never-played before replayed
// (a reopened song comes back at zero votes and must not shadow songs that
// have not had their turn), then the one that played longest ago, then the
// DJ's order. The ballot and the crowd pick share this so they agree.
const pickOrderSql = `votes DESC, (t.played_at IS NOT NULL) ASC, t.played_at ASC, t.position ASC`;

// Votes cast since the track last played. Earlier ones were spent by that
// play; the rows stay so a guest's free vote remains used and history is kept.
const liveVotesJoinSql = `
  LEFT JOIN (
    SELECT track_id, created_at FROM votes WHERE session_id = ?
    UNION ALL
    SELECT track_id, created_at FROM anonymous_votes WHERE session_id = ?
  ) v ON v.track_id = t.id AND v.created_at > COALESCE(t.played_at, '')`;

// A vote only counts if it is stamped after the song's last play, and play
// stamps can sit a few milliseconds ahead of the clock (see setNowPlaying),
// so a vote cast right after a play is stepped past it rather than lost.
function voteStamp(playedAt: string | null) {
  const now = new Date().toISOString();
  return playedAt && playedAt >= now
    ? new Date(Date.parse(playedAt) + 1).toISOString()
    : now;
}

function trackPreviewUrl(trackId: string, previewKey: string | null) {
  return previewKey ? `/api/tracks/${encodeURIComponent(trackId)}/preview` : null;
}

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
        `SELECT id, name, venue, created_at, expires_at, ended_at, revision,
                now_playing_track_id, now_playing_started_at
         FROM sessions
         WHERE id = ? AND ended_at IS NULL AND expires_at > ?`,
      )
      .get(sessionId.toUpperCase(), new Date().toISOString()) as
      | SessionRow
      | undefined;
    if (!session) return null;

    // Songs on cooldown sink below the ballot; among the rest the crowd's
    // votes decide, and the crowd pick is the first open one.
    const tracks = database
      .prepare(
        `SELECT t.id, t.title, t.artist, t.position, t.preview_key, t.played_at,
                 ${trackCooldownSql} AS cooldown,
                 COUNT(v.track_id) AS votes
         FROM tracks t
         ${liveVotesJoinSql}
         WHERE t.session_id = ?
         GROUP BY t.id
         ORDER BY ((${trackCooldownSql}) > 0) ASC, ${pickOrderSql}`,
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
    // Only votes cast since the track last played: an older one was spent by
    // that play and the account is free to vote the song back up.
    const votedTrackIds = accountId
      ? (
          database
            .prepare(
              `SELECT v.track_id FROM votes v
               JOIN tracks t ON t.id = v.track_id
               WHERE v.session_id = ? AND v.account_id = ?
                 AND v.created_at > COALESCE(t.played_at, '')`,
            )
            .all(session.id, accountId) as Array<{ track_id: string }>
        ).map((vote) => vote.track_id)
      : [];

    const playing = session.now_playing_track_id
      ? tracks.find((track) => track.id === session.now_playing_track_id)
      : undefined;

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
      nowPlaying:
        playing && session.now_playing_started_at
          ? {
              trackId: playing.id,
              title: playing.title,
              artist: playing.artist,
              previewUrl: trackPreviewUrl(playing.id, playing.preview_key),
              startedAt: session.now_playing_started_at,
            }
          : null,
      tracks: tracks.map((track) => ({
        id: track.id,
        title: track.title,
        artist: track.artist,
        votes: track.votes,
        position: track.position,
        previewUrl: trackPreviewUrl(track.id, track.preview_key),
        playedAt: track.played_at,
        cooldown: track.cooldown,
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
        // An empty string is "no request ID", not a request ID; storing it
        // would occupy the per-host unique index for every later blank one.
        input.requestId || null,
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
  const rows = getDatabase()
    .prepare(
      `SELECT v.track_id, v.created_at > COALESCE(t.played_at, '') AS live
       FROM anonymous_votes v JOIN tracks t ON t.id = v.track_id
       WHERE v.session_id = ? AND v.voter_id = ?`,
    )
    .all(session.id, voterId) as Array<{ track_id: string; live: number }>;
  const claimed = Boolean(
    getDatabase()
      .prepare("SELECT 1 FROM voter_accounts WHERE voter_id = ?")
      .get(voterId),
  );
  return {
    ...session,
    // The free vote stays used once cast; it only shows as a live pick while
    // the song has not played since, so the guest can re-tap it afterwards.
    votedTrackIds: rows.filter((row) => row.live).map((row) => row.track_id),
    anonymousVoteUsed: claimed || rows.length > 0,
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

/**
 * Put a song on. "next" takes the top-voted track that is not on cooldown —
 * the crowd's pick — and null takes the current one off. A played song is
 * stamped so it sits out for the cooldown and its votes are spent, and the
 * revision bumps so every guest's next poll carries the change.
 */
export function setNowPlaying(input: {
  sessionId: string;
  hostKey: string;
  accountId: string;
  trackId: string | "next" | null;
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

      let trackId: string | null = null;
      if (input.trackId === "next") {
        const next =
          (database
            .prepare(
              `SELECT t.id, COUNT(v.track_id) AS votes
               FROM tracks t
               ${liveVotesJoinSql}
               WHERE t.session_id = ? AND (${trackCooldownSql}) = 0
               GROUP BY t.id
               ORDER BY ${pickOrderSql}
               LIMIT 1`,
            )
            .get(session.id, session.id, session.id) as { id: string } | undefined) ??
          // Nothing open (only possible in a room too small to cool down):
          // the least recently played song rather than dead air.
          (database
            .prepare(
              `SELECT id FROM tracks WHERE session_id = ?
               ORDER BY (played_at IS NOT NULL) ASC, played_at ASC, position ASC
               LIMIT 1`,
            )
            .get(session.id) as { id: string } | undefined);
        if (!next) return "no_track" as const;
        trackId = next.id;
      } else if (input.trackId) {
        const track = database
          .prepare("SELECT id FROM tracks WHERE id = ? AND session_id = ?")
          .get(input.trackId, session.id) as { id: string } | undefined;
        if (!track) return "no_track" as const;
        trackId = track.id;
      }

      if (trackId) {
        // "Played after" is decided by comparing stamps, so two plays must
        // never share one: step past the room's latest if the clock has not.
        const latest = (
          database
            .prepare("SELECT MAX(played_at) AS latest FROM tracks WHERE session_id = ?")
            .get(session.id) as { latest: string | null }
        ).latest;
        const stamp =
          latest && latest >= now
            ? new Date(Date.parse(latest) + 1).toISOString()
            : now;
        // Every vote on it is spent from this stamp on: rows stay for the
        // room's totals, but only votes cast after it count or show as picks.
        database.prepare("UPDATE tracks SET played_at = ? WHERE id = ?").run(stamp, trackId);
      }
      database
        .prepare(
          `UPDATE sessions
           SET now_playing_track_id = ?, now_playing_started_at = ?,
               revision = revision + 1
           WHERE id = ?`,
        )
        .run(trackId, trackId ? now : null, session.id);
      return "updated" as const;
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
        .prepare(
          `SELECT t.id, t.played_at, ${trackCooldownSql} AS cooldown
           FROM tracks t WHERE t.id = ? AND t.session_id = ?`,
        )
        .get(input.trackId, session.id) as
        | { id: string; played_at: string | null; cooldown: number }
        | undefined;
      if (!track) return null;

      // A vote from before the song last played was spent by that play; it
      // counts as no vote here so the same account can vote it back up.
      const existingVote = database
        .prepare(
          `SELECT 1 FROM votes WHERE track_id = ? AND account_id = ?
             AND created_at > COALESCE(?, '')`,
        )
        .get(track.id, input.accountId, track.played_at);
      const voted = input.enabled ?? !existingVote;
      const changed = voted !== Boolean(existingVote);
      // A song on cooldown is off the ballot for now. Taking a vote back off
      // it is still allowed; a guest whose poll has not caught up must not
      // spend one on it.
      if (voted && changed && track.cooldown > 0) {
        throw new CooldownError(track.cooldown);
      }
      if (voted && changed) {
        database
          .prepare(
            `INSERT INTO votes (track_id, session_id, account_id, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (track_id, account_id)
             DO UPDATE SET created_at = excluded.created_at`,
          )
          .run(track.id, session.id, input.accountId, voteStamp(track.played_at));
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
        .prepare(
          `SELECT t.id, t.played_at, ${trackCooldownSql} AS cooldown
           FROM tracks t WHERE t.id = ? AND t.session_id = ?`,
        )
        .get(input.trackId, session.id) as
        | { id: string; played_at: string | null; cooldown: number }
        | undefined;
      if (!track) return { status: "not_found" as const };
      // The one free vote must not land on a song that is sitting out.
      if (track.cooldown > 0) {
        return { status: "cooldown" as const, songsRemaining: track.cooldown };
      }

      const claimed = database
        .prepare("SELECT 1 FROM voter_accounts WHERE voter_id = ?")
        .get(input.voterId);
      if (claimed) return { status: "phone_required" as const };

      const existing = database
        .prepare(
          `SELECT track_id, created_at FROM anonymous_votes
           WHERE session_id = ? AND voter_id = ?`,
        )
        .get(session.id, input.voterId) as
        | { track_id: string; created_at: string }
        | undefined;
      if (existing) {
        if (existing.track_id !== track.id) {
          return { status: "phone_required" as const };
        }
        // Same song again. If the earlier tap was spent by a play, this one
        // is a fresh vote and has to count; otherwise it is a harmless repeat.
        if (existing.created_at <= (track.played_at ?? "")) {
          database
            .prepare(
              `UPDATE anonymous_votes SET created_at = ?
               WHERE session_id = ? AND voter_id = ?`,
            )
            .run(voteStamp(track.played_at), session.id, input.voterId);
          database
            .prepare("UPDATE sessions SET revision = revision + 1 WHERE id = ?")
            .run(session.id);
        }
        return { status: "voted" as const, sessionId: session.id };
      }

      database
        .prepare(
          `INSERT INTO anonymous_votes
            (track_id, session_id, voter_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(track.id, session.id, input.voterId, voteStamp(track.played_at));
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
  sizeBytes?: number;
}) {
  getDatabase()
    .prepare(
      `INSERT INTO audio_uploads
        (object_key, account_id, original_name, request_id, created_at, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.objectKey,
      input.accountId,
      input.originalName,
      input.requestId ?? null,
      new Date().toISOString(),
      Math.max(0, Math.floor(input.sizeBytes ?? 0)),
    );
}

/** Bytes this account currently holds in R2, counting every registered upload. */
export function getAccountStorageBytes(accountId: string) {
  const row = getDatabase()
    .prepare(
      "SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM audio_uploads WHERE account_id = ?",
    )
    .get(accountId) as { bytes: number };
  return row.bytes;
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

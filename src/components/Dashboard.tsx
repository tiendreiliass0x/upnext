"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUp,
  AudioLines,
  Check,
  Copy,
  Headphones,
  ListMusic,
  Pause,
  Phone,
  Play,
  Plus,
  QrCode,
  Radio,
  RotateCcw,
  Share2,
  Upload,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import QRCode from "react-qr-code";
import type { PublicAccount } from "@/lib/accounts";
import { classifyGuestOrigin, type GuestOriginReach } from "@/lib/config";
import { readJson } from "@/lib/http-client";
import type { Library, LibraryTrack } from "@/lib/libraries";
import type { NowPlaying } from "@/lib/sessions";
import type { PublicSession, SessionTrack, TrackVoter } from "@/lib/sessions";

type AppView = "dj" | "guest";

const accountTokenStorageKey = "upnext-account-token";
const accountRequestStorageKey = "upnext-account-request-id";
const voterIdStorageKey = "upnext-voter-id";
const anonymousVotesStorageKey = "upnext-anonymous-votes";

type DraftTrack = {
  id: string;
  title: string;
  artist: string;
  source: "demo" | "upload" | "playlist" | "library";
  file?: File;
  previewKey?: string;
};

const demoTracks: DraftTrack[] = [
  {
    id: "demo-1",
    title: "NUEVAYoL",
    artist: "Bad Bunny",
    source: "demo",
  },
  {
    id: "demo-2",
    title: "Sticky",
    artist: "Tyler, The Creator",
    source: "demo",
  },
  {
    id: "demo-3",
    title: "Guess",
    artist: "Charli xcx feat. Billie Eilish",
    source: "demo",
  },
  {
    id: "demo-4",
    title: "Messy",
    artist: "Lola Young",
    source: "demo",
  },
  {
    id: "demo-5",
    title: "APT.",
    artist: "ROSÉ & Bruno Mars",
    source: "demo",
  },
];

function createClientId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isClientId(value: string | null): value is string {
  return Boolean(
    value &&
      value.length >= 16 &&
      value.length <= 100 &&
      /^[A-Za-z0-9_-]+$/.test(value),
  );
}

function getStoredAnonymousVote(sessionId: string) {
  try {
    const stored = window.localStorage.getItem(anonymousVotesStorageKey);
    if (!stored) return null;
    const votes = JSON.parse(stored) as Record<string, unknown>;
    const trackId = votes[sessionId.toUpperCase()];
    return typeof trackId === "string" ? trackId : null;
  } catch {
    return null;
  }
}

function rememberAnonymousVote(sessionId: string, trackId: string) {
  try {
    const stored = window.localStorage.getItem(anonymousVotesStorageKey);
    const votes = stored
      ? (JSON.parse(stored) as Record<string, unknown>)
      : {};
    votes[sessionId.toUpperCase()] = trackId;
    window.localStorage.setItem(anonymousVotesStorageKey, JSON.stringify(votes));
  } catch {
    // The server still enforces the anonymous vote limit when storage is blocked.
  }
}

function forgetAnonymousVote(sessionId: string) {
  try {
    const stored = window.localStorage.getItem(anonymousVotesStorageKey);
    if (!stored) return;
    const votes = JSON.parse(stored) as Record<string, unknown>;
    delete votes[sessionId.toUpperCase()];
    window.localStorage.setItem(anonymousVotesStorageKey, JSON.stringify(votes));
  } catch {
    // The account token becomes the source of identity after onboarding.
  }
}

function trackFromName(
  name: string,
  source: DraftTrack["source"],
  file?: File,
): DraftTrack {
  const rawName = name.split("/").pop() ?? name;
  let decodedName = rawName;
  try {
    decodedName = decodeURIComponent(rawName);
  } catch {
    // Local filenames can contain unmatched percent signs.
  }
  const cleanName = decodedName
    .replace(/\.(mp3|wav|m4a|aac|flac|ogg|aiff?|opus)$/i, "")
    .replace(/^\d{1,3}[. _-]+/, "")
    .trim();
  const separator = [" - ", " – ", " — "].find((item) =>
    cleanName.includes(item),
  );
  const parts = separator ? cleanName.split(separator) : [cleanName];
  const artist = parts.length > 1 ? parts.shift()?.trim() : "Unknown artist";
  const title = parts.join(separator ?? " ").trim() || cleanName || "Untitled track";

  return {
    id: createClientId(),
    title,
    artist: artist || "Unknown artist",
    source,
    file,
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function getGuestLink(sessionId: string, baseUrl?: string | null) {
  // Fall back to the address the DJ is on only when nothing is configured.
  // That address is often unreachable for guests, which is why the live room
  // warns about what it is handing out.
  let url: URL;
  try {
    url = new URL(baseUrl || window.location.href);
  } catch {
    url = new URL(window.location.href);
  }
  url.search = "";
  url.hash = "";
  url.searchParams.set("session", sessionId);
  return url.toString();
}


async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = 8000,
) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (requestError) {
    if (timedOut) throw new Error("The connection timed out.");
    throw requestError;
  } finally {
    window.clearTimeout(timer);
  }
}

// A beat after the song ends before the next one goes on, so the room hears
// it finish rather than being cut off by a clock that runs slightly ahead.
const autoAdvanceGraceMs = 1500;
// How often the booth checks whether the song has run out. A repeating check
// rather than one long timer: it retries an advance that failed on bad wifi,
// re-probes a song whose length could not be read, and is not thrown off by
// a browser throttling timers in a tab sitting behind the DJ software.
const autoAdvanceCheckMs = 5000;
const autoAdvanceProbeAttempts = 5;

function disposeAudio(audio: HTMLAudioElement) {
  audio.onended = null;
  audio.onerror = null;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
}

// One song at a time, whichever component started it: a guest auditioning a
// row while the DJ's song is on would otherwise hear both.
let exclusiveAudio: HTMLAudioElement | null = null;
function claimAudio(audio: HTMLAudioElement) {
  if (exclusiveAudio && exclusiveAudio !== audio) exclusiveAudio.pause();
  exclusiveAudio = audio;
}

function formatClock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The song the DJ has on, docked under the ballot. Playback needs a tap the
 * first time (browsers block unprompted audio), after which a change of song
 * follows automatically. A late joiner starts partway through, offset by how
 * long the DJ has had it on, so the phone roughly tracks the room.
 */
/**
 * Stays mounted for the life of the guest view, even while nothing is on:
 * the first tap "unlocks" this one <audio> element for unprompted playback,
 * and unmounting it would make every guest tap again for the next song.
 */
export function NowPlayingDock({ nowPlaying }: { nowPlaying: NowPlaying | null }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Which song this element was last started for, so the effect below does
  // not restart what the tap handler already started synchronously.
  const startedKeyRef = useRef("");
  const [listening, setListening] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [status, setStatus] = useState<"" | "failed" | "finished">("");
  const trackId = nowPlaying?.trackId ?? "";
  const previewUrl = nowPlaying?.previewUrl ?? null;
  const startedAt = nowPlaying?.startedAt ?? "";
  const songKey = `${trackId}|${startedAt}`;

  function silence(audio: HTMLAudioElement) {
    audio.onloadedmetadata = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    startedKeyRef.current = "";
    setIsPlaying(false);
  }

  // Start the DJ's song from roughly where the room is. Called straight from
  // the tap handler the first time, because WebKit only honours play() while
  // it is still inside the user gesture; an effect runs too late for that.
  function start(audio: HTMLAudioElement, url: string, since: string) {
    const offset = Math.max(0, (Date.now() - Date.parse(since)) / 1000);
    startedKeyRef.current = songKey;
    setPosition(0);
    setDuration(0);
    setStatus("");
    audio.src = url;
    audio.onloadedmetadata = () => {
      if (!Number.isFinite(audio.duration)) return;
      if (offset < audio.duration) {
        audio.currentTime = offset;
        return;
      }
      // The room is past the end of this one. Playing it from the top would
      // be a different song from what the room hears, so say so instead.
      silence(audio);
      setStatus("finished");
    };
    claimAudio(audio);
    audio.play().catch(() => {
      if (startedKeyRef.current === songKey) setStatus("failed");
    });
  }

  // Follow later changes of song automatically once the guest has tapped.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !listening) return;
    if (!previewUrl) {
      if (startedKeyRef.current) silence(audio);
      setStatus("");
      return;
    }
    if (startedKeyRef.current === songKey) return;
    start(audio, previewUrl, startedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start/silence are stable per render and keyed by songKey
  }, [listening, previewUrl, startedAt, songKey]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      if (audio) disposeAudio(audio);
    };
  }, []);

  return (
    <div
      className="player-dock now-playing-dock"
      role="region"
      aria-label="Now playing"
      hidden={!nowPlaying}
    >
      <div className="player-dock-inner">
        <button
          type="button"
          className="player-main-button"
          aria-label={isPlaying ? "Pause the DJ's song" : "Listen along"}
          disabled={!previewUrl || status === "finished"}
          onClick={() => {
            const audio = audioRef.current;
            if (!audio || !previewUrl) return;
            if (!listening) {
              start(audio, previewUrl, startedAt);
              setListening(true);
            } else if (audio.paused) {
              claimAudio(audio);
              audio.play().catch(() => setStatus("failed"));
            } else {
              audio.pause();
            }
          }}
        >
          {isPlaying ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <span className="track-copy player-now">
          <small className="now-playing-label">DJ is playing</small>
          <strong>{nowPlaying?.title ?? ""}</strong>
          <small>
            {nowPlaying?.artist ?? ""}
            {!previewUrl
              ? " · no audio for this one"
              : status === "failed"
                ? " · could not play"
                : status === "finished"
                  ? " · this one's finished"
                  : ""}
          </small>
        </span>
        {listening && previewUrl && (
          <>
            <span className="player-progress" aria-hidden="true">
              <span
                style={{
                  width: `${duration > 0 ? Math.min(100, (position / duration) * 100) : 0}%`,
                }}
              />
            </span>
            <span className="player-time">
              {formatClock(position)}{duration > 0 ? ` / ${formatClock(duration)}` : ""}
            </span>
          </>
        )}
        <audio
          ref={audioRef}
          preload="none"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
          onDurationChange={(event) => {
            const value = event.currentTarget.duration;
            setDuration(Number.isFinite(value) ? value : 0);
          }}
          onError={() => setStatus("failed")}
        />
      </div>
    </div>
  );
}

export default function Dashboard({
  initialSessionId = "",
  initialPlaylistId = "",
}: {
  initialSessionId?: string;
  initialPlaylistId?: string;
}) {
  const sharedSessionId = initialSessionId.trim().toUpperCase().slice(0, 40);
  const seedPlaylistId = initialPlaylistId.trim().slice(0, 100);
  const [view, setView] = useState<AppView>(sharedSessionId ? "guest" : "dj");
  const [joinedViaLink, setJoinedViaLink] = useState(Boolean(sharedSessionId));
  const [isLive, setIsLive] = useState(Boolean(sharedSessionId));
  const [sessionName, setSessionName] = useState("Friday After Dark");
  const [venue, setVenue] = useState("Room 02");
  const [draftTracks, setDraftTracks] = useState<DraftTrack[]>(demoTracks);
  const [session, setSession] = useState<PublicSession | null>(null);
  const [activeSessionId, setActiveSessionId] = useState(sharedSessionId);
  const [hostKey, setHostKey] = useState("");
  const [sessionLink, setSessionLink] = useState("");
  const [guestBaseUrl, setGuestBaseUrl] = useState<string | null>(null);
  const [account, setAccount] = useState<PublicAccount | null>(null);
  const [accountToken, setAccountToken] = useState("");
  const [voterId, setVoterId] = useState("");
  const [anonymousVoteUsed, setAnonymousVoteUsed] = useState(false);
  const [identityRequested, setIdentityRequested] = useState(false);
  const [pendingIdentityVote, setPendingIdentityVote] = useState("");
  const [identityStatus, setIdentityStatus] = useState<
    "loading" | "needed" | "ready"
  >("loading");
  const [identityError, setIdentityError] = useState("");
  const retryNowRef = useRef<(() => void) | null>(null);
  const [votedTrackIds, setVotedTrackIds] = useState<Set<string>>(new Set());
  const [pendingVotes, setPendingVotes] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [isRecoveringHost, setIsRecoveringHost] = useState(
    !Boolean(sharedSessionId),
  );
  const [isEnding, setIsEnding] = useState(false);
  const [isChangingTrack, setIsChangingTrack] = useState(false);
  // Server time minus booth time, learned from poll responses.
  const serverClockOffsetRef = useRef(0);
  const [isLoadingSession, setIsLoadingSession] = useState(
    Boolean(sharedSessionId),
  );
  const [roomMissing, setRoomMissing] = useState(false);
  const [roomError, setRoomError] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const activeSessionIdRef = useRef(activeSessionId);
  const accountRequestIdRef = useRef("");
  const setupLockedRef = useRef(false);
  const sessionRequestIdRef = useRef("");
  const sessionRevisionRef = useRef<{ id: string; revision: number } | null>(
    null,
  );
  const sessionTagRef = useRef<{ id: string; tag: string } | null>(null);
  const playlistSeededRef = useRef(false);
  activeSessionIdRef.current = activeSessionId;

  useEffect(() => {
    let nextVoterId = createClientId();
    try {
      const savedVoterId = window.localStorage.getItem(voterIdStorageKey);
      if (isClientId(savedVoterId)) {
        nextVoterId = savedVoterId;
      } else {
        window.localStorage.setItem(voterIdStorageKey, nextVoterId);
      }
      nextVoterId =
        window.localStorage.getItem(voterIdStorageKey) ?? nextVoterId;
    } catch {
      // An in-memory ID still allows voting for this tab.
    }
    setVoterId(nextVoterId);
  }, []);

  useEffect(() => {
    setAnonymousVoteUsed(
      Boolean(activeSessionId && getStoredAnonymousVote(activeSessionId)),
    );
  }, [activeSessionId]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;

    async function restoreAccount() {
      let savedToken = "";
      try {
        savedToken = window.localStorage.getItem(accountTokenStorageKey) ?? "";
      } catch {
        // The phone form remains available when storage is blocked.
      }

      if (!savedToken) {
        if (!cancelled) setIdentityStatus("needed");
        return;
      }

      try {
        const response = await fetchWithTimeout("/api/accounts", {
          cache: "no-store",
          headers: { Authorization: `Bearer ${savedToken}` },
        });
        const data = (await response.json()) as {
          account?: PublicAccount;
          error?: string;
        };
        if (response.status === 401) {
          try {
            window.localStorage.removeItem(accountTokenStorageKey);
          } catch {
            // The expired token can also be replaced in memory.
          }
          if (!cancelled) setIdentityStatus("needed");
          return;
        }
        if (!response.ok || !data.account) {
          throw new Error(data.error || "Your profile could not be loaded.");
        }

        if (!cancelled) {
          setAccount(data.account);
          setAccountToken(savedToken);
          setIdentityStatus("ready");
          setIdentityError("");
        }
      } catch (restoreError) {
        if (cancelled) return;
        // Keep retrying (a deploy restart is the usual cause), but say so:
        // a silent spinner is indistinguishable from a hung page. Backing
        // off keeps a long outage from hammering the box.
        attempts += 1;
        setIdentityError(
          restoreError instanceof Error && restoreError.message
            ? restoreError.message
            : "Your profile could not be loaded.",
        );
        retryTimer = window.setTimeout(
          restoreAccount,
          Math.min(2000 * 2 ** (attempts - 1), 15000),
        );
      }
    }

    let attempts = 0;
    retryNowRef.current = () => {
      if (retryTimer) window.clearTimeout(retryTimer);
      void restoreAccount();
    };
    void restoreAccount();
    return () => {
      cancelled = true;
      retryNowRef.current = null;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    if (
      identityStatus !== "ready" ||
      !accountToken ||
      sharedSessionId
    ) {
      return;
    }

    let cancelled = false;
    async function restoreHostRoom() {
      try {
        const response = await fetchWithTimeout("/api/sessions", {
          cache: "no-store",
          headers: { Authorization: `Bearer ${accountToken}` },
        });
        const data = (await response.json()) as {
          activeRoom?: { session: PublicSession; hostKey: string } | null;
          guestBaseUrl?: string | null;
        };
        if (!cancelled && data.guestBaseUrl) setGuestBaseUrl(data.guestBaseUrl);
        if (!response.ok || !data.activeRoom || cancelled) return;

        sessionRevisionRef.current = {
          id: data.activeRoom.session.id,
          revision: data.activeRoom.session.revision,
        };
        setSession(data.activeRoom.session);
        setActiveSessionId(data.activeRoom.session.id);
        setHostKey(data.activeRoom.hostKey);
        setIsLive(true);
        setIsLoadingSession(false);
      } catch {
        // A failed recovery should not block creating a new room.
      } finally {
        if (!cancelled) setIsRecoveringHost(false);
      }
    }

    void restoreHostRoom();
    return () => {
      cancelled = true;
    };
  }, [accountToken, identityStatus, sharedSessionId]);

  // /play hands over here with ?playlist=<id>. The draft is seeded from the
  // playlist instead of a room being created outright, so the DJ still names
  // the room, can reorder or drop songs, and an existing live room is never
  // silently joined by a second one.
  useEffect(() => {
    if (
      !seedPlaylistId ||
      sharedSessionId ||
      identityStatus !== "ready" ||
      !accountToken ||
      playlistSeededRef.current
    ) {
      return;
    }
    playlistSeededRef.current = true;

    let cancelled = false;
    async function seedFromPlaylist() {
      try {
        const response = await fetchWithTimeout(
          `/api/playlists/${encodeURIComponent(seedPlaylistId)}`,
          { headers: { Authorization: `Bearer ${accountToken}` } },
        );
        const data = await readJson<{
          playlist?: { id: string; name: string };
          tracks?: LibraryTrack[];
          error?: string;
        }>(response);
        if (cancelled) return;
        if (!response.ok || !data.playlist || !data.tracks) {
          setError(data.error || "That playlist could not be found.");
          return;
        }
        if (data.tracks.length === 0) {
          setError("That playlist has no songs yet. Add some in Play first.");
          return;
        }
        setSessionName(data.playlist.name.slice(0, 80));
        setDraftTracks(
          data.tracks.slice(0, 200).map((track) => ({
            id: track.id,
            title: track.title,
            artist: track.artist,
            source: "library",
            previewKey: track.libraryPreviewKey ?? undefined,
          })),
        );
        setError("");
        // The seed has been consumed. Drop the parameter so a reload does not
        // run it again over whatever the DJ has renamed, reordered or dropped.
        window.history.replaceState({}, "", window.location.pathname);
      } catch (requestError) {
        if (!cancelled) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "The playlist could not be loaded.",
          );
        }
      }
    }

    void seedFromPlaylist();
    return () => {
      cancelled = true;
    };
  }, [accountToken, identityStatus, seedPlaylistId, sharedSessionId]);

  // Kept in an effect rather than derived during render: getGuestLink reads
  // window.location, which does not exist while this component is server
  // rendered.
  useEffect(() => {
    if (!activeSessionId) {
      setSessionLink("");
      return;
    }
    setSessionLink(getGuestLink(activeSessionId, guestBaseUrl));
  }, [activeSessionId, guestBaseUrl]);

  useEffect(() => {
    if (!activeSessionId || identityStatus === "loading" || !voterId) return;

    let cancelled = false;
    let refreshTimer: number | undefined;

    async function refreshSession() {
      let shouldContinue = true;
      try {
        const knownTag = sessionTagRef.current;
        const response = await fetchWithTimeout(
          `/api/sessions/${encodeURIComponent(activeSessionId)}`,
          {
            cache: "no-store",
            headers: {
              ...(accountToken
                ? { Authorization: `Bearer ${accountToken}` }
                : { "x-upnext-voter-id": voterId }),
              ...(knownTag && knownTag.id === activeSessionId.toUpperCase()
                ? { "If-None-Match": knownTag.tag }
                : {}),
            },
          },
        );

        // The server's clock, for the auto-advance: startedAt is server time
        // and a booth laptop can be seconds off. The Date header is whole
        // seconds; the grace period covers the rounding.
        const serverDate = Date.parse(response.headers.get("date") ?? "");
        if (Number.isFinite(serverDate)) {
          serverClockOffsetRef.current = serverDate - Date.now();
        }

        // The room is unchanged, so there is no body to read and no state to
        // replace. Skipping the update also avoids a re-render on every poll.
        if (response.status === 304) {
          // Defensive, and unreachable by construction: the tag is now only
          // stored when the payload is adopted, so holding one implies holding
          // the room. Kept because the failure it guards is a permanently
          // blank room, and dev-mode Fast Refresh can preserve a ref while
          // resetting the state beside it.
          const held = sessionRevisionRef.current;
          if (!held || held.id !== activeSessionId.toUpperCase()) {
            sessionTagRef.current = null;
            return;
          }
          if (!cancelled) {
            setRoomMissing(false);
            setRoomError("");
            setIsLoadingSession(false);
          }
          return;
        }

        const data = (await response.json()) as {
          session?: PublicSession;
          error?: string;
        };

        if (response.status === 404) {
          shouldContinue = false;
          if (!cancelled) {
            sessionRevisionRef.current = null;
            sessionTagRef.current = null;
            setSession(null);
            setRoomMissing(true);
            setRoomError(data.error || "This room is no longer live.");
            setIsLoadingSession(false);
          }
          return;
        }

        if (!response.ok || !data.session) {
          throw new Error(data.error || "This room could not be loaded.");
        }

        if (!cancelled) {
          const nextSession = data.session;
          const responseTag = response.headers.get("etag");
          const latestRevision = sessionRevisionRef.current;
          if (
            !latestRevision ||
            latestRevision.id !== nextSession.id ||
            latestRevision.revision <= nextSession.revision
          ) {
            sessionRevisionRef.current = {
              id: nextSession.id,
              revision: nextSession.revision,
            };
            // Only now do we actually hold this room. If-None-Match asserts
            // "I already have this version", so storing the tag for a payload
            // we discarded would ask the server to skip a body we never
            // rendered, and the room would never appear.
            sessionTagRef.current = responseTag
              ? { id: nextSession.id, tag: responseTag }
              : null;
            setSession(nextSession);
            setVotedTrackIds(new Set(nextSession.votedTrackIds));
            if (!accountToken) {
              setAnonymousVoteUsed(nextSession.anonymousVoteUsed);
              if (nextSession.votedTrackIds.length > 0) {
                rememberAnonymousVote(
                  nextSession.id,
                  nextSession.votedTrackIds[0],
                );
              } else if (!nextSession.anonymousVoteUsed) {
                forgetAnonymousVote(nextSession.id);
              }
            }
          }
          setRoomMissing(false);
          setRoomError("");
          setIsLoadingSession(false);
        }
      } catch (refreshError) {
        if (!cancelled) {
          setRoomError(getErrorMessage(refreshError));
          setIsLoadingSession(false);
        }
      } finally {
        if (!cancelled && shouldContinue) {
          refreshTimer = window.setTimeout(refreshSession, 2000);
        }
      }
    }

    void refreshSession();

    return () => {
      cancelled = true;
      if (refreshTimer) window.clearTimeout(refreshTimer);
    };
  }, [accountToken, activeSessionId, identityStatus, voterId]);

  async function finishIdentity(data: {
    account: PublicAccount;
    token: string;
  }) {
    setAccount(data.account);
    setAccountToken(data.token);
    setIdentityStatus("ready");
    setIdentityRequested(false);
    setAnonymousVoteUsed(false);
    try {
      window.localStorage.setItem(accountTokenStorageKey, data.token);
      window.localStorage.removeItem(accountRequestStorageKey);
    } catch {
      // The profile remains active for this tab.
    }
    accountRequestIdRef.current = "";
    if (activeSessionId) forgetAnonymousVote(activeSessionId);

    const nextTrackId = pendingIdentityVote;
    setPendingIdentityVote("");
    if (nextTrackId) await submitVote(nextTrackId, data.token);
  }

  async function saveIdentity(phone: string, pseudonym: string) {
    if (!accountRequestIdRef.current) {
      try {
        const savedRequestId = window.localStorage.getItem(
          accountRequestStorageKey,
        );
        accountRequestIdRef.current = isClientId(savedRequestId)
          ? savedRequestId
          : createClientId();
        window.localStorage.setItem(
          accountRequestStorageKey,
          accountRequestIdRef.current,
        );
      } catch {
        accountRequestIdRef.current = createClientId();
      }
    }
    const response = await fetchWithTimeout("/api/accounts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(voterId ? { "x-upnext-voter-id": voterId } : {}),
      },
      body: JSON.stringify({
        phone,
        pseudonym,
        requestId: accountRequestIdRef.current,
      }),
    });
    const data = (await response.json()) as {
      account?: PublicAccount;
      token?: string;
      error?: string;
    };

    if (!response.ok || !data.account || !data.token) {
      throw new Error(data.error || "Your profile could not be saved.");
    }

    await finishIdentity({ account: data.account, token: data.token });
  }

  async function loginIdentity(phone: string) {
    const response = await fetchWithTimeout("/api/accounts/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(voterId ? { "x-upnext-voter-id": voterId } : {}),
      },
      body: JSON.stringify({ phone }),
    });
    const data = (await response.json()) as {
      account?: PublicAccount;
      token?: string;
      error?: string;
    };

    if (!response.ok || !data.account || !data.token) {
      throw new Error(data.error || "Your account could not be logged in.");
    }

    await finishIdentity({ account: data.account, token: data.token });
  }

  async function addFiles(files: FileList | File[]) {
    if (setupLockedRef.current) return;
    const fileList = Array.from(files);
    if (fileList.length === 0) return;

    const incoming: DraftTrack[] = [];

    try {
      for (const file of fileList) {
        if (/\.(m3u8?|txt)$/i.test(file.name)) {
          const lines = (await file.text())
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#"));
          incoming.push(
            ...lines.map((line) => trackFromName(line, "playlist")),
          );
        } else {
          incoming.push(trackFromName(file.name, "upload", file));
        }
      }
    } catch {
      setError("That playlist could not be read. Try the audio files directly.");
      return;
    }

    if (setupLockedRef.current) return;
    setDraftTracks((current) => {
      const base = current.every((track) => track.source === "demo")
        ? []
        : current;
      const knownTracks = new Set(
        base.map((track) => `${track.artist}-${track.title}`.toLowerCase()),
      );
      const uniqueIncoming = incoming.filter((track) => {
        const key = `${track.artist}-${track.title}`.toLowerCase();
        if (knownTracks.has(key)) return false;
        knownTracks.add(key);
        return true;
      });

      return [...base, ...uniqueIncoming].slice(0, 200);
    });
    setError("");
  }

  function addLibraryTracks(picked: LibraryTrack[]) {
    if (setupLockedRef.current || picked.length === 0) return;
    setDraftTracks((current) => {
      const base = current.every((track) => track.source === "demo") ? [] : current;
      // A catalogue song already has its preview, so the same song twice would
      // upload nothing but would still queue twice. Library tracks keep the
      // catalogue ID as their draft ID, so that is the key to compare on.
      const known = new Set(base.map((track) => track.id));
      const additions: DraftTrack[] = [];
      for (const track of picked) {
        const key = track.id;
        if (known.has(key)) continue;
        known.add(key);
        additions.push({
          id: track.id,
          title: track.title,
          artist: track.artist,
          source: "library",
          previewKey: track.libraryPreviewKey ?? undefined,
        });
      }
      return [...base, ...additions].slice(0, 200);
    });
    setError("");
  }

  async function startSession() {
    if (setupLockedRef.current) return;
    if (!accountToken) {
      setError("Sign in before opening a room.");
      return;
    }
    if (!sessionName.trim() || draftTracks.length === 0) {
      setError("Add a session name and at least one track.");
      return;
    }

    setupLockedRef.current = true;
    setIsStarting(true);
    setError("");

    try {
      let preparedTracks = [...draftTracks];
      const tracksToUpload = preparedTracks.filter(
        (track) => track.file && !track.previewKey,
      );

      for (let index = 0; index < tracksToUpload.length; index += 1) {
        const track = tracksToUpload[index];
        if (!track.file) continue;
        // The original file goes up as-is: no decode, no re-encode, so the
        // booth tab never stalls on a DJ's phone while a song is prepared.
        const step = `${index + 1} of ${tracksToUpload.length}`;
        setUploadProgress(`Uploading ${track.title} (${step})`);
        const formData = new FormData();
        formData.append("file", track.file);
        const uploadResponse = await fetchWithTimeout(
          "/api/uploads",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accountToken}`,
              "x-upnext-upload-id": track.id,
            },
            body: formData,
          },
          5 * 60_000,
        );
        const uploadData = await readJson<{
          previewKey?: string;
          error?: string;
        }>(uploadResponse);
        if (!uploadResponse.ok || !uploadData.previewKey) {
          throw new Error(
            uploadData.error || `A preview for ${track.title} could not be created.`,
          );
        }

        preparedTracks = preparedTracks.map((item) =>
          item.id === track.id
            ? { ...item, previewKey: uploadData.previewKey }
            : item,
        );
        setDraftTracks(preparedTracks);
      }

      setUploadProgress("Opening live room");
      if (!sessionRequestIdRef.current) {
        sessionRequestIdRef.current = createClientId();
      }
      const response = await fetchWithTimeout("/api/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accountToken}`,
        },
        body: JSON.stringify({
          name: sessionName,
          venue,
          requestId: sessionRequestIdRef.current,
          tracks: preparedTracks.map(({ title, artist, previewKey }) => ({
            title,
            artist,
            previewKey,
          })),
        }),
      });
      const data = (await response.json()) as {
        session?: PublicSession;
        hostKey?: string;
        guestBaseUrl?: string | null;
        error?: string;
      };

      if (!response.ok || !data.session || !data.hostKey) {
        throw new Error(data.error || "The room could not be opened.");
      }

      if (data.guestBaseUrl) setGuestBaseUrl(data.guestBaseUrl);
      sessionRevisionRef.current = {
        id: data.session.id,
        revision: data.session.revision,
      };
      setSession(data.session);
      sessionRequestIdRef.current = "";
      setActiveSessionId(data.session.id);
      setHostKey(data.hostKey);
      setIsLive(true);
      setRoomMissing(false);
      setRoomError("");
    } catch (startError) {
      setError(getErrorMessage(startError));
    } finally {
      setupLockedRef.current = false;
      setIsStarting(false);
      setUploadProgress("");
    }
  }

  async function submitVote(trackId: string, credential = accountToken) {
    if (!activeSessionId || !voterId || pendingVotes.has(trackId)) return;

    const votingSessionId = activeSessionId;
    setPendingVotes((current) => new Set(current).add(trackId));
    setError("");

    try {
      const response = await fetchWithTimeout(
        `/api/sessions/${encodeURIComponent(votingSessionId)}/vote`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(credential
              ? { Authorization: `Bearer ${credential}` }
              : { "x-upnext-voter-id": voterId }),
          },
          body: JSON.stringify({
            trackId,
            enabled: !votedTrackIds.has(trackId),
          }),
        },
      );
      const data = (await response.json()) as {
        session?: PublicSession;
        voted?: boolean;
        error?: string;
        code?: string;
      };

      if (
        !credential &&
        response.status === 403 &&
        data.code === "PHONE_REQUIRED"
      ) {
        setPendingIdentityVote(trackId);
        setIdentityRequested(true);
        return;
      }

      if (!response.ok || !data.session || typeof data.voted !== "boolean") {
        throw new Error(data.error || "Your vote could not be saved.");
      }

      if (activeSessionIdRef.current !== votingSessionId) return;

      const nextSession = data.session;
      const latestRevision = sessionRevisionRef.current;
      if (
        !latestRevision ||
        latestRevision.id !== nextSession.id ||
        latestRevision.revision <= nextSession.revision
      ) {
        sessionRevisionRef.current = {
          id: nextSession.id,
          revision: nextSession.revision,
        };
        setSession(nextSession);
        setVotedTrackIds(new Set(nextSession.votedTrackIds));
      }
      if (!credential) {
        rememberAnonymousVote(votingSessionId, trackId);
        setAnonymousVoteUsed(true);
      }
      setRoomError("");
    } catch (voteError) {
      setError(getErrorMessage(voteError));
    } finally {
      setPendingVotes((current) => {
        const next = new Set(current);
        next.delete(trackId);
        return next;
      });
    }
  }

  async function voteForTrack(trackId: string) {
    if (!accountToken && anonymousVoteUsed) {
      setPendingIdentityVote(trackId);
      setIdentityRequested(true);
      return;
    }
    await submitVote(trackId);
  }

  async function copySessionLink() {
    if (!sessionLink) return;

    try {
      await navigator.clipboard.writeText(sessionLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Copying failed. Select the room link manually.");
    }
  }

  function clearActiveSession() {
    sessionRevisionRef.current = null;
    sessionTagRef.current = null;
    sessionRequestIdRef.current = "";
    setSession(null);
    setActiveSessionId("");
    setHostKey("");
    setSessionLink("");
    setIsLive(false);
    setView("dj");
    setJoinedViaLink(false);
    setVotedTrackIds(new Set());
    setRoomMissing(false);
    setRoomError("");
    setError("");
    window.history.replaceState({}, "", window.location.pathname);
  }

  // The host key goes in a header (never a URL) and the signed R2 URL comes
  // back as JSON, since an <audio src> cannot carry headers.
  async function auditionTrack(track: SessionTrack) {
    if (!track.previewUrl) throw new Error("This track has no audio.");
    const response = await fetchWithTimeout(`${track.previewUrl}?as=json`, {
      cache: "no-store",
      headers: { "x-upnext-host-key": hostKey },
    });
    const data = await readJson<{ url?: string; error?: string }>(response);
    if (!response.ok || !data.url) {
      throw new Error(data.error || "This track could not be loaded.");
    }
    return data.url;
  }

  async function changeNowPlaying(
    trackId: string | "next" | null,
    fromTrackId?: string,
  ) {
    if (!activeSessionId || !hostKey || isChangingTrack) return;
    const roomId = activeSessionId;
    setIsChangingTrack(true);
    setError("");
    try {
      const response = await fetchWithTimeout(
        `/api/sessions/${encodeURIComponent(roomId)}/now-playing`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-upnext-host-key": hostKey,
            Authorization: `Bearer ${accountToken}`,
          },
          body: JSON.stringify(
            fromTrackId === undefined ? { trackId } : { trackId, fromTrackId },
          ),
        },
      );
      const data = await readJson<{
        session?: PublicSession | null;
        error?: string;
      }>(response);
      if (!response.ok || !data.session) {
        throw new Error(data.error || "The song could not be changed.");
      }
      if (activeSessionIdRef.current !== roomId) return;
      const next = data.session;
      const latest = sessionRevisionRef.current;
      if (!latest || latest.id !== next.id || latest.revision <= next.revision) {
        sessionRevisionRef.current = { id: next.id, revision: next.revision };
        setSession(next);
      }
    } catch (changeError) {
      setError(getErrorMessage(changeError));
    } finally {
      setIsChangingTrack(false);
    }
  }

  // Auto-advance. When the song the DJ has on runs out and nothing has
  // changed, put the crowd pick on. The booth learns the length from the
  // file's metadata (the server never decodes audio), and the request names
  // the song it is meant to follow, so a second booth tab or a request that
  // was slow while the DJ tapped cannot skip one. Needs this tab open: the
  // guest phones only follow, they never drive. It runs whichever view the
  // host is looking at — holding the host key is what makes this the booth,
  // and switching to the crowd view to show someone the ballot must not
  // leave the room in silence.
  const changeNowPlayingRef = useRef(changeNowPlaying);
  changeNowPlayingRef.current = changeNowPlaying;
  const playingTrackId = session?.nowPlaying?.trackId ?? null;
  const playingStartedAt = session?.nowPlaying?.startedAt ?? null;
  const playingPreviewUrl = session?.nowPlaying?.previewUrl ?? null;
  useEffect(() => {
    if (!isLive || !hostKey || !playingTrackId || !playingStartedAt || !playingPreviewUrl) {
      return;
    }
    let endsAt: number | null = null;
    let probe: HTMLAudioElement | null = null;
    let probeAttempts = 0;

    const dropProbe = () => {
      if (!probe) return;
      probe.onloadedmetadata = null;
      probe.onerror = null;
      disposeAudio(probe);
      probe = null;
    };
    const check = () => {
      if (endsAt === null) {
        // No length yet: the probe failed or is still loading. Try again a
        // few times, then leave it to the DJ.
        if (!probe && probeAttempts < autoAdvanceProbeAttempts) startProbe();
        return;
      }
      if (Date.now() + serverClockOffsetRef.current < endsAt) return;
      // Retried on the next check if it fails or a change is in flight; the
      // server ignores it once the song has moved on.
      void changeNowPlayingRef.current("next", playingTrackId);
    };
    const startProbe = () => {
      probeAttempts += 1;
      const element = new Audio();
      probe = element;
      element.preload = "metadata";
      element.onloadedmetadata = () => {
        if (probe !== element) return;
        if (Number.isFinite(element.duration) && element.duration > 0) {
          endsAt =
            Date.parse(playingStartedAt) + element.duration * 1000 + autoAdvanceGraceMs;
          check();
        }
        dropProbe();
      };
      element.onerror = () => {
        if (probe === element) dropProbe();
      };
      element.src = playingPreviewUrl;
    };

    startProbe();
    const interval = window.setInterval(check, autoAdvanceCheckMs);
    return () => {
      window.clearInterval(interval);
      dropProbe();
    };
  }, [isLive, hostKey, playingTrackId, playingStartedAt, playingPreviewUrl]);

  async function endCurrentSession() {
    if (!activeSessionId || !hostKey || isEnding) return;

    setIsEnding(true);
    setError("");
    try {
      const response = await fetchWithTimeout(
        `/api/sessions/${encodeURIComponent(activeSessionId)}`,
        {
          method: "DELETE",
          headers: {
            "x-upnext-host-key": hostKey,
            Authorization: `Bearer ${accountToken}`,
          },
        },
      );
      const data = (await response.json()) as { error?: string };

      if (!response.ok && response.status !== 404) {
        throw new Error(data.error || "The room could not be ended.");
      }

      clearActiveSession();
    } catch (endError) {
      setError(getErrorMessage(endError));
    } finally {
      setIsEnding(false);
    }
  }

  if (identityStatus === "loading" || !voterId) {
    return (
      <div className="upnext-app">
        <header className="app-header">
          <span className="wordmark">
            <span className="wordmark-dot" aria-hidden="true" />
            YOU/NEXT
          </span>
        </header>
        <LoadingRoom
          label="Loading your profile"
          error={identityError}
          onRetry={() => retryNowRef.current?.()}
        />
      </div>
    );
  }

  if (
    (identityStatus === "needed" || !account) &&
    (!sharedSessionId || identityRequested)
  ) {
    return (
      <div className="upnext-app">
        <header className="app-header">
          <span className="wordmark">
            <span className="wordmark-dot" aria-hidden="true" />
            YOU/NEXT
          </span>
          {sharedSessionId && (
            <span className="guest-header-room">
              <Radio size={14} /> Room {sharedSessionId}
            </span>
          )}
        </header>
        <IdentityGate
          joiningRoom={Boolean(sharedSessionId)}
          afterFreeVote={identityRequested}
          onSave={saveIdentity}
          onLogin={loginIdentity}
        />
      </div>
    );
  }

  const previewSession: PublicSession = {
    id: "PREVIEW",
    name: sessionName || "Untitled session",
    venue,
    createdAt: "",
    revision: 0,
    totalVotes: 0,
    guestCount: 0,
    votedTrackIds: [],
    anonymousVoteUsed: false,
    nowPlaying: null,
    voters: [],
    tracks: draftTracks.map((track, position) => ({
      id: track.id,
      title: track.title,
      artist: track.artist,
      votes: 0,
      position,
      previewUrl: null,
      playedAt: null,
      cooldown: 0,
      voters: [],
    })),
  };
  const guestDockVisible =
    view === "guest" && !roomMissing && Boolean(session?.nowPlaying);
  const visibleError = error || roomError;

  return (
    <div className={`upnext-app${guestDockVisible ? " has-dock" : ""}`}>
      <header className="app-header">
        <button
          type="button"
          className="wordmark"
          onClick={() => setView("dj")}
          disabled={joinedViaLink}
          aria-label="Open DJ booth"
        >
          <span className="wordmark-dot" aria-hidden="true" />
          YOU/NEXT
        </button>

        <div className="header-actions">
          {joinedViaLink ? (
            <span className="guest-header-room">
              <Radio size={14} /> Room {activeSessionId}
            </span>
          ) : (
            <nav className="view-switcher" aria-label="Choose app view">
              <button
                type="button"
                className={view === "dj" ? "is-active" : ""}
                onClick={() => setView("dj")}
                aria-pressed={view === "dj"}
              >
                <Headphones size={16} strokeWidth={2} />
                DJ booth
              </button>
              <button
                type="button"
                className={view === "guest" ? "is-active" : ""}
                onClick={() => setView("guest")}
                aria-pressed={view === "guest"}
              >
                <UsersRound size={16} strokeWidth={2} />
                Crowd view
              </button>
            </nav>
          )}
          {/* Only for a signed-in host: the catalogue is not public, so a guest
              following this link would only meet a sign-in notice. */}
          {!joinedViaLink && accountToken && (
            <Link className="text-button" href="/play">
              <ListMusic size={15} /> Play
            </Link>
          )}
          {account ? (
            <span
              className="profile-chip"
              title={`Signed in as ${account.pseudonym}, phone ending ${account.phoneLast4}`}
            >
              <span>{account.pseudonym.slice(0, 1).toUpperCase()}</span>
              <strong>{account.pseudonym}</strong>
            </span>
          ) : (
            <span className="profile-chip" title="Anonymous browser voter">
              <span>{anonymousVoteUsed ? "1" : "0"}</span>
              <strong>{anonymousVoteUsed ? "Vote saved" : "Free vote"}</strong>
            </span>
          )}
        </div>
      </header>

      {visibleError && (
        <div className="error-banner" role="alert">
          <span>{visibleError}</span>
          <button
            type="button"
            onClick={() => {
              setError("");
              setRoomError("");
            }}
            aria-label="Dismiss"
          >
            <X size={18} />
          </button>
        </div>
      )}

      {view === "dj" && !isLive && (
        isRecoveringHost ? (
          <LoadingRoom label="Checking your live rooms" />
        ) : (
          <DJSetup
          sessionName={sessionName}
          venue={venue}
          tracks={draftTracks}
          isDragging={isDragging}
          isStarting={isStarting}
          uploadProgress={uploadProgress}
          onSessionNameChange={setSessionName}
          onVenueChange={setVenue}
          onAddFiles={addFiles}
          onDragChange={setIsDragging}
          onRemoveTrack={(trackId) =>
            !isStarting &&
            setDraftTracks((current) =>
              current.filter((track) => track.id !== trackId),
            )
          }
          onClear={() => !isStarting && setDraftTracks([])}
          onRestoreDemo={() => !isStarting && setDraftTracks(demoTracks)}
          accountToken={accountToken}
          onAddLibraryTracks={addLibraryTracks}
          onStart={startSession}
          />
        )
      )}

      {view === "dj" && isLive && roomMissing && (
        <MissingRoom isHost onReset={clearActiveSession} />
      )}

      {view === "dj" && isLive && !roomMissing && !session && !isLoadingSession && (
        <ConnectionRoom />
      )}

      {view === "dj" && isLive && !roomMissing && (session || isLoadingSession) && (
        <DJLiveRoom
          session={session}
          sessionLink={sessionLink}
          copied={copied}
          isLoading={isLoadingSession}
          isEnding={isEnding}
          linkReach={sessionLink ? classifyGuestOrigin(sessionLink) : "unknown"}
          onCopy={copySessionLink}
          onOpenGuest={() => setView("guest")}
          onEnd={() => void endCurrentSession()}
          isChangingTrack={isChangingTrack}
          onPlay={(trackId) => void changeNowPlaying(trackId)}
          onAudition={auditionTrack}
        />
      )}

      {view === "guest" && roomMissing && (
        <MissingRoom />
      )}

      {view === "guest" && activeSessionId && !roomMissing && !session && isLoadingSession && (
        <LoadingRoom label="Joining the room" />
      )}

      {view === "guest" && activeSessionId && !roomMissing && !session && !isLoadingSession && (
        <ConnectionRoom />
      )}

      {view === "guest" && !roomMissing && (!activeSessionId || session) && (
        <GuestRoom
          session={session ?? previewSession}
          isPreview={!activeSessionId}
          isLoading={isLoadingSession}
          votedTrackIds={votedTrackIds}
          pendingVotes={pendingVotes}
          isAnonymous={!accountToken}
          anonymousVoteUsed={anonymousVoteUsed}
          onVote={voteForTrack}
          onBackToDJ={() => setView("dj")}
        />
      )}
    </div>
  );
}

export function LibraryPicker({
  accountToken,
  disabled = false,
  onAdd,
}: {
  accountToken: string;
  disabled?: boolean;
  onAdd: (tracks: LibraryTrack[]) => void;
}) {
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [libraryId, setLibraryId] = useState("");
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [pickerError, setPickerError] = useState("");

  useEffect(() => {
    if (!accountToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithTimeout("/api/libraries", {
          cache: "no-store",
          headers: { Authorization: `Bearer ${accountToken}` },
        });
        const data = await readJson<{ libraries?: Library[]; error?: string }>(
          response,
        );
        if (!response.ok || !data.libraries) throw new Error(data.error || "");
        if (cancelled) return;
        setLibraries(data.libraries);
        setLibraryId((current) => current || data.libraries?.[0]?.id || "");
      } catch {
        if (!cancelled) setLibraries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountToken]);

  useEffect(() => {
    if (!accountToken || !libraryId) {
      setTracks([]);
      return;
    }
    let cancelled = false;
    // Debounced so a typed search does not fire a request per keystroke.
    const timer = window.setTimeout(() => {
      void (async () => {
        setIsLoading(true);
        try {
          const response = await fetchWithTimeout(
            `/api/libraries/${encodeURIComponent(libraryId)}/tracks?q=${encodeURIComponent(query)}`,
            {
              cache: "no-store",
              headers: { Authorization: `Bearer ${accountToken}` },
            },
          );
          const data = await readJson<{
            tracks?: LibraryTrack[];
            error?: string;
          }>(response);
          if (!response.ok || !data.tracks) {
            throw new Error(data.error || "The library could not be read.");
          }
          if (!cancelled) {
            setTracks(data.tracks);
            setPickerError("");
          }
        } catch (error) {
          if (!cancelled) setPickerError(getErrorMessage(error));
        } finally {
          if (!cancelled) setIsLoading(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [accountToken, libraryId, query]);

  // Nothing to show before the catalogue has any libraries in it.
  if (!accountToken || libraries === null || libraries.length === 0) return null;

  const selected = tracks.filter((track) => picked.has(track.id));

  return (
    <div className="library-picker">
      <div className="library-picker-head">
        <span className="eyebrow">
          <ListMusic size={14} /> Pick from a library
        </span>
        <select
          aria-label="Choose a library"
          value={libraryId}
          disabled={disabled}
          onChange={(event) => {
            setLibraryId(event.target.value);
            setPicked(new Set());
          }}
        >
          {libraries.map((library) => (
            <option key={library.id} value={library.id}>
              {library.name} ({library.trackCount})
            </option>
          ))}
        </select>
      </div>

      <input
        type="search"
        className="library-search"
        placeholder="Search title or artist"
        aria-label="Search this library"
        value={query}
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
      />

      {pickerError && <p className="form-error" role="alert">{pickerError}</p>}

      {isLoading && tracks.length === 0 ? (
        <p className="library-empty">Loading songs...</p>
      ) : tracks.length === 0 ? (
        <p className="library-empty">
          {query ? "No songs match that search." : "This library is empty."}
        </p>
      ) : (
        <ul className="library-list">
          {tracks.map((track) => (
            <li key={track.id}>
              <label>
                <input
                  type="checkbox"
                  checked={picked.has(track.id)}
                  disabled={disabled}
                  onChange={() =>
                    setPicked((current) => {
                      const next = new Set(current);
                      if (next.has(track.id)) next.delete(track.id);
                      else next.add(track.id);
                      return next;
                    })
                  }
                />
                <span className="track-copy">
                  <strong>{track.title}</strong>
                  <small>
                    {track.artist}
                    {track.previewUrl ? "" : " · no audio"}
                  </small>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="secondary-button"
        disabled={disabled || selected.length === 0}
        onClick={() => {
          onAdd(selected);
          setPicked(new Set());
        }}
      >
        <Plus size={16} />
        {selected.length === 0
          ? "Select songs to add"
          : `Add ${selected.length} song${selected.length === 1 ? "" : "s"}`}
      </button>
    </div>
  );
}

type DJSetupProps = {
  sessionName: string;
  venue: string;
  tracks: DraftTrack[];
  isDragging: boolean;
  isStarting: boolean;
  uploadProgress: string;
  onSessionNameChange: (value: string) => void;
  onVenueChange: (value: string) => void;
  onAddFiles: (files: FileList | File[]) => Promise<void>;
  onDragChange: (value: boolean) => void;
  onRemoveTrack: (trackId: string) => void;
  onClear: () => void;
  onRestoreDemo: () => void;
  accountToken: string;
  onAddLibraryTracks: (tracks: LibraryTrack[]) => void;
  onStart: () => void;
};

function DJSetup({
  sessionName,
  venue,
  tracks,
  isDragging,
  isStarting,
  uploadProgress,
  onSessionNameChange,
  onVenueChange,
  onAddFiles,
  onDragChange,
  onRemoveTrack,
  onClear,
  onRestoreDemo,
  accountToken,
  onAddLibraryTracks,
  onStart,
}: DJSetupProps) {
  return (
    <main className="setup-page page-shell">
      <section className="setup-hero">
        <div>
          <span className="eyebrow">
            <Radio size={14} /> Set up your session
          </span>
          <h1>
            Broadcast your set.
            <span>Let your fans steer it.</span>
          </h1>
        </div>
        <p>
          For music curators and DJs. Open a live session, share one link, and
          every fan&apos;s phone bids on what plays next.
        </p>
      </section>

      <div className="setup-grid">
        <div className="setup-main">
          <section className="form-section" aria-labelledby="room-details-title">
            <div className="section-number">01</div>
            <div className="section-content">
              <div className="section-heading">
                <h2 id="room-details-title">Name the session</h2>
                <p>This is what your fans see when they join.</p>
              </div>
              <div className="field-grid">
                <label className="field">
                  <span>Session name</span>
                  <input
                    type="text"
                    value={sessionName}
                    maxLength={80}
                    disabled={isStarting}
                    onChange={(event) => onSessionNameChange(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Location <small>optional</small></span>
                  <input
                    type="text"
                    value={venue}
                    maxLength={80}
                    disabled={isStarting}
                    onChange={(event) => onVenueChange(event.target.value)}
                  />
                </label>
              </div>
            </div>
          </section>

          <section className="form-section" aria-labelledby="music-title">
            <div className="section-number">02</div>
            <div className="section-content">
              <div className="section-heading track-heading">
                <div>
                  <h2 id="music-title">Add the music</h2>
                  <p>Full songs, stored privately and streamed to your fans.</p>
                </div>
                {tracks.length > 0 && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={onClear}
                    disabled={isStarting}
                  >
                    Clear all
                  </button>
                )}
              </div>

              <LibraryPicker
                accountToken={accountToken}
                disabled={isStarting}
                onAdd={onAddLibraryTracks}
              />

              <label
                className={`upload-zone ${isDragging ? "is-dragging" : ""} ${isStarting ? "is-disabled" : ""}`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  if (isStarting) return;
                  onDragChange(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => onDragChange(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  if (isStarting) return;
                  onDragChange(false);
                  void onAddFiles(event.dataTransfer.files);
                }}
              >
                <input
                  type="file"
                  multiple
                  disabled={isStarting}
                  accept="audio/*,.m3u,.m3u8,.txt"
                  onChange={(event) => {
                    if (event.target.files) void onAddFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
                <span className="upload-icon">
                  <Upload size={24} strokeWidth={1.8} />
                </span>
                <span className="upload-copy">
                  <strong>Choose files</strong> or drop them here
                  <small>MP3, WAV, M4A, FLAC · snippets upload on start</small>
                </span>
                <span className="upload-action">
                  <Plus size={18} /> Add tracks
                </span>
              </label>

              {tracks.length > 0 ? (
                <div className="draft-list">
                  <div className="draft-list-meta">
                    <span>{tracks.length} tracks ready</span>
                    <span>Crowd ranking enabled</span>
                  </div>
                  <ol>
                    {tracks.map((track, index) => (
                      <li key={track.id}>
                        <span className="track-index">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="track-copy">
                          <strong>{track.title}</strong>
                          <small>{track.artist}</small>
                          <span className="preview-status">
                            {track.previewKey
                              ? "Preview ready"
                              : track.file
                                ? "30-sec preview queued"
                                : "Voting only"}
                          </span>
                        </span>
                        <button
                          type="button"
                          className="remove-track"
                          onClick={() => onRemoveTrack(track.id)}
                          disabled={isStarting}
                          aria-label={`Remove ${track.title}`}
                        >
                          <X size={18} />
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : (
                <div className="empty-tracks">
                  <ListMusic size={26} strokeWidth={1.6} />
                  <div>
                    <strong>Your set is empty</strong>
                    <p>Add files above or restore the example playlist.</p>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={onRestoreDemo}
                    disabled={isStarting}
                  >
                    Restore demo
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>

        <aside className="launch-panel">
          <div className="launch-art" aria-hidden="true">
            <span>YOU</span>
            <AudioLines size={54} strokeWidth={1.3} />
            <span>NEXT</span>
          </div>
          <div className="launch-copy">
            <span className="status-line">
              <span /> Ready when you are
            </span>
            <h2>{sessionName || "Your next session"}</h2>
            <p>
              {tracks.length} {tracks.length === 1 ? "track" : "tracks"}
              {venue ? ` · ${venue}` : ""}
            </p>
          </div>
          <button
            type="button"
            className="primary-button launch-button"
            onClick={onStart}
            disabled={isStarting || tracks.length === 0 || !sessionName.trim()}
          >
            <span>
              {isStarting ? uploadProgress || "Opening room..." : "Start session"}
            </span>
            <ArrowRight size={20} />
          </button>
          <small className="launch-note">
            Your music is stored privately and only streams inside the session.
          </small>
        </aside>
      </div>
    </main>
  );
}

type DJLiveRoomProps = {
  session: PublicSession | null;
  sessionLink: string;
  copied: boolean;
  isLoading: boolean;
  isEnding: boolean;
  linkReach: GuestOriginReach;
  onCopy: () => void;
  onOpenGuest: () => void;
  onEnd: () => void;
  isChangingTrack: boolean;
  onPlay: (trackId: string | "next" | null) => void;
  /** Resolves a row to a playable URL for the DJ's pre-listen. */
  onAudition: (track: SessionTrack) => Promise<string>;
};

function DJLiveRoom({
  session,
  sessionLink,
  copied,
  isLoading,
  isEnding,
  linkReach,
  onCopy,
  onOpenGuest,
  onEnd,
  isChangingTrack,
  onPlay,
  onAudition,
}: DJLiveRoomProps) {
  if (isLoading || !session || !sessionLink) {
    return <LoadingRoom label="Opening the room" />;
  }
  const nextUp = session.tracks.find((track) => track.cooldown === 0);

  return (
    <main className="live-page page-shell">
      <section className="live-heading">
        <div>
          <span className="live-pill"><span /> Live session</span>
          <h1>{session.name}</h1>
          <p>{session.venue || "Location not set"} · Code {session.id}</p>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={onEnd}
          disabled={isEnding}
        >
          <RotateCcw size={17} /> {isEnding ? "Ending..." : "End session"}
        </button>
      </section>

      <div className="live-grid">
        <section className="share-panel" aria-labelledby="share-title">
          <div className="share-copy">
            <span className="eyebrow"><QrCode size={14} /> Invite the crowd</span>
            <h2 id="share-title">Scan. Vote. Move the queue.</h2>
            <p>Put this QR on a screen or send the guest room link.</p>
          </div>
          {linkReach === "loopback" ? (
            // A loopback link resolves to the guest's own phone, so the code
            // would fail for every single scan. Showing one would be worse
            // than showing none.
            <div className="link-warning is-blocking" role="alert">
              <strong>This link cannot reach any guest.</strong>
              <span>
                The booth is open on a loopback address, which points at
                whichever device scans it rather than at this server. Set
                APP_PUBLIC_URL to the address guests will use, or reopen the
                booth on that address.
              </span>
            </div>
          ) : (
            <div className="qr-frame">
              <QRCode
                value={sessionLink}
                size={168}
                bgColor="#ffffff"
                fgColor="#161711"
                level="M"
              />
            </div>
          )}
          {linkReach === "private" && (
            <p className="link-warning" role="status">
              <strong>Same-network link.</strong>
              <span>
                This address only resolves on your network, so guests on mobile
                data cannot open it. Set APP_PUBLIC_URL for a link that works
                anywhere.
              </span>
            </p>
          )}
          <div className="room-code">
            <span>Room code</span>
            <strong>{session.id}</strong>
          </div>
          <button type="button" className="primary-button" onClick={onCopy}>
            {copied ? <Check size={18} /> : <Copy size={18} />}
            {copied ? "Link copied" : "Copy guest link"}
          </button>
          <input
            className="share-url"
            value={sessionLink}
            readOnly
            aria-label="Guest room link"
            onFocus={(event) => event.currentTarget.select()}
          />
          <button type="button" className="preview-link" onClick={onOpenGuest}>
            Preview crowd view <ArrowRight size={16} />
          </button>
        </section>

        <section className="queue-panel" aria-labelledby="live-queue-title">
          <div className="queue-header">
            <div>
              <span>Live ranking</span>
              <h2 id="live-queue-title">Crowd queue</h2>
              <VoterStack
                voters={session.voters}
                votes={session.guestCount}
                label="In the room"
                className="room-voters"
              />
            </div>
            <div className="live-stats">
              <span><strong>{session.guestCount}</strong> voters</span>
              <span><strong>{session.totalVotes}</strong> votes</span>
            </div>
          </div>
          <section className="now-playing-panel" aria-labelledby="now-playing-title">
            <div className="now-playing-copy">
              <span className="eyebrow"><AudioLines size={14} /> Now playing</span>
              {session.nowPlaying ? (
                <>
                  <strong id="now-playing-title">{session.nowPlaying.title}</strong>
                  <span>{session.nowPlaying.artist}</span>
                </>
              ) : (
                <strong id="now-playing-title">Nothing on yet</strong>
              )}
            </div>
            <div className="now-playing-actions">
              <button
                type="button"
                className="primary-button"
                disabled={isChangingTrack || !nextUp}
                onClick={() => onPlay("next")}
              >
                <Play size={16} fill="currentColor" />
                {nextUp ? `Play crowd pick: ${nextUp.title}` : "Everything is cooling down"}
              </button>
              {session.nowPlaying && (
                <button
                  type="button"
                  className="text-button"
                  disabled={isChangingTrack}
                  onClick={() => onPlay(null)}
                >
                  Take it off
                </button>
              )}
            </div>
          </section>
          <QueueList
            tracks={session.tracks}
            onAudition={onAudition}
            onPlay={(track) => onPlay(track.id)}
            nowPlayingTrackId={session.nowPlaying?.trackId ?? null}
            isChangingTrack={isChangingTrack}
          />
        </section>
      </div>
    </main>
  );
}

type GuestRoomProps = {
  session: PublicSession;
  isPreview: boolean;
  isLoading: boolean;
  votedTrackIds: Set<string>;
  pendingVotes: Set<string>;
  isAnonymous: boolean;
  anonymousVoteUsed: boolean;
  onVote: (trackId: string) => void;
  onBackToDJ: () => void;
};

function GuestRoom({
  session,
  isPreview,
  isLoading,
  votedTrackIds,
  pendingVotes,
  isAnonymous,
  anonymousVoteUsed,
  onVote,
  onBackToDJ,
}: GuestRoomProps) {
  if (isLoading) return <LoadingRoom label="Joining the room" />;

  const topTrack = session.tracks.find((track) => track.cooldown === 0);

  return (
    <main className="guest-page page-shell">
      <section className="guest-heading">
        <div>
          <span className={isPreview ? "preview-pill" : "live-pill"}>
            <span /> {isPreview ? "Crowd preview" : `Live · ${session.id}`}
          </span>
          <h1>{session.name}</h1>
          <p>
            {isPreview
              ? "This is what guests see after scanning your QR."
              : isAnonymous
                ? anonymousVoteUsed
                  ? "Your free vote is saved. Add your phone when you want another pick."
                  : "Your first vote is free. We only ask for your phone when you vote again."
                : "Vote for the tracks you want to hear. Tap again to undo."}
          </p>
        </div>
        {isPreview && (
          <button type="button" className="secondary-button" onClick={onBackToDJ}>
            Back to setup
          </button>
        )}
      </section>
      <p className="vote-announcement" aria-live="polite" aria-atomic="true">
        {session.totalVotes} total votes.
        {topTrack ? ` ${topTrack.title} is ranked first.` : ""}
      </p>

      {topTrack && (
        <section className="top-pick">
          <div className="top-pick-label">
            <AudioLines size={19} />
            {session.totalVotes > 0 ? "Crowd pick" : "First in queue"}
          </div>
          <div className="top-pick-copy">
            <strong>{topTrack.title}</strong>
            <span>{topTrack.artist}</span>
          </div>
          <div className="top-pick-votes">
            <ArrowUp size={17} /> {topTrack.votes}
          </div>
        </section>
      )}

      <section className="guest-ballot" aria-labelledby="ballot-title">
        <div className="guest-ballot-heading">
          <div>
            <span>Up next</span>
            <h2 id="ballot-title">Make your picks</h2>
            <VoterStack
              voters={session.voters}
              votes={session.guestCount}
              label="In the room"
              className="room-voters"
            />
          </div>
          <span className="track-count">{session.tracks.length} tracks</span>
        </div>

        {session.tracks.length > 0 ? (
          <QueueList
            tracks={session.tracks}
            interactive={!isPreview}
            votedTrackIds={votedTrackIds}
            pendingVotes={pendingVotes}
            lockSelectedVotes={isAnonymous}
            onVote={onVote}
          />
        ) : (
          <div className="empty-ballot">
            <ListMusic size={30} strokeWidth={1.5} />
            <strong>No tracks in this room yet</strong>
          </div>
        )}
      </section>

      <p className="guest-note">
        <Share2 size={15} /> {isAnonymous
          ? "One free vote per room. Add your phone to keep voting."
          : "Tap once per track. The most-voted track stays on top."}
      </p>
      <NowPlayingDock nowPlaying={session.nowPlaying} />
    </main>
  );
}

// Deterministic so a pseudonym keeps its colour across rows and reloads.
function voterHue(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % 360;
}

function voterSummary(voters: TrackVoter[], votes: number) {
  const names = voters.flatMap((voter) => (voter.name ? [voter.name] : []));
  const shown = names.slice(0, 2);
  const others = votes - shown.length;
  if (shown.length === 0) {
    return votes === 1 ? "1 guest voted" : `${votes} guests voted`;
  }
  if (others <= 0) return shown.join(" and ");
  return `${shown.join(", ")} and ${others} other${others === 1 ? "" : "s"}`;
}

/**
 * How many of `count` faces fit in `width` pixels when each face is
 * `faceWidth` wide and every face after the first overlaps the previous one
 * by `overlap`. When they do not all fit, one slot is kept for the "+N"
 * bubble. An unknown width (nothing measured yet) shows everything.
 */
export function facesThatFit(input: {
  width: number;
  faceWidth: number;
  overlap: number;
  count: number;
}) {
  const { width, faceWidth, overlap, count } = input;
  if (width <= 0 || faceWidth <= 0) return count;
  const step = Math.max(1, faceWidth - overlap);
  const slots = Math.max(1, Math.floor((width - faceWidth) / step) + 1);
  if (count <= slots) return count;
  return Math.max(1, slots - 1);
}

/**
 * The faces behind a row's votes: an initial for each named voter, a blank
 * bubble for a free anonymous vote, then "A, B and N others". Voting is the
 * social act in the room, so who's in on a song should be visible, not just
 * a number — as many as the screen has room for, and "+N" for the rest.
 */
function VoterStack({
  voters,
  votes,
  label = "Voted by",
  className = "",
}: {
  voters: TrackVoter[];
  votes: number;
  label?: string;
  className?: string;
}) {
  const stackRef = useRef<HTMLSpanElement | null>(null);
  // null: not measured (first paint, or no ResizeObserver) — show them all.
  const [capacity, setCapacity] = useState<number | null>(null);

  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const first = stack.querySelector<HTMLElement>(".voter-face");
      const second = first?.nextElementSibling as HTMLElement | null;
      if (!first) return;
      const faceWidth = first.offsetWidth;
      // The overlap is the negative margin on every face after the first;
      // if it cannot be read (no second face, or no computed style) assume
      // the stylesheet's roughly 30% rather than none.
      const measured = second ? -parseFloat(getComputedStyle(second).marginLeft) : NaN;
      const overlap =
        Number.isFinite(measured) && measured > 0 ? measured : Math.round(faceWidth * 0.3);
      setCapacity(
        facesThatFit({ width: stack.clientWidth, faceWidth, overlap, count: voters.length }),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stack);
    return () => observer.disconnect();
  }, [voters.length]);

  if (votes === 0) return null;
  const shown = capacity === null ? voters : voters.slice(0, capacity);
  const hidden = votes - shown.length;
  return (
    <span
      // A bare span cannot carry a name (ARIA forbids naming generic
      // elements and screen readers drop it); as a group it can, so the
      // "In the room" / "Voted by" context is announced with the names.
      role="group"
      ref={stackRef}
      className={`voter-stack ${className}`.trim()}
      aria-label={`${label} ${voterSummary(voters, votes)}`}
    >
      <span className="voter-faces" aria-hidden="true">
        {shown.map((voter, index) =>
          voter.name ? (
            <span
              key={index}
              className="voter-face"
              style={{ "--face-hue": voterHue(voter.name) } as CSSProperties}
              title={voter.name}
            >
              {voter.name.slice(0, 1).toUpperCase()}
            </span>
          ) : (
            <span key={index} className="voter-face is-anonymous" title="Guest">
              <UserRound size={11} strokeWidth={2.4} />
            </span>
          ),
        )}
        {hidden > 0 && <span className="voter-face is-more">+{hidden}</span>}
      </span>
      <small>{voterSummary(voters, votes)}</small>
    </span>
  );
}

type QueueListProps = {
  tracks: SessionTrack[];
  interactive?: boolean;
  votedTrackIds?: Set<string>;
  pendingVotes?: Set<string>;
  lockSelectedVotes?: boolean;
  onVote?: (trackId: string) => void;
  /**
   * When given, rows with audio get a play button that resolves through this
   * before playing. Only the DJ's live room passes it; guests hear the
   * broadcast and nothing else.
   */
  onAudition?: (track: SessionTrack) => Promise<string>;
  /**
   * When given, every row gets a Play that puts that song on the room. The
   * crowd pick stays the one-tap default in the panel above; this is for the
   * DJ's own call: a request from the floor, a change of mood, a song still
   * cooling. Cooldown limits votes, not the DJ.
   */
  onPlay?: (track: SessionTrack) => void;
  /** The song on now; its row shows that instead of a Play. */
  nowPlayingTrackId?: string | null;
  /** A change is in flight; Plays wait for it rather than racing it. */
  isChangingTrack?: boolean;
};

export function QueueList({
  tracks,
  interactive = false,
  votedTrackIds = new Set(),
  pendingVotes = new Set(),
  lockSelectedVotes = false,
  onVote,
  onAudition,
  onPlay,
  nowPlayingTrackId = null,
  isChangingTrack = false,
}: QueueListProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingTrackId, setPlayingTrackId] = useState("");
  const [loadingTrackId, setLoadingTrackId] = useState("");

  useEffect(() => {
    return () => {
      if (audioRef.current) disposeAudio(audioRef.current);
      audioRef.current = null;
    };
  }, []);

  function stopAudition() {
    if (audioRef.current) disposeAudio(audioRef.current);
    audioRef.current = null;
    setPlayingTrackId("");
    setLoadingTrackId("");
  }

  async function toggleAudition(track: SessionTrack) {
    if (!onAudition || !track.previewUrl) return;
    if (playingTrackId === track.id || loadingTrackId === track.id) {
      stopAudition();
      return;
    }

    stopAudition();
    const audio = new Audio();
    audio.preload = "none";
    audioRef.current = audio;
    setLoadingTrackId(track.id);
    audio.onended = () => {
      if (audioRef.current === audio) {
        audioRef.current = null;
        setPlayingTrackId("");
      }
    };
    audio.onerror = () => {
      if (audioRef.current === audio) {
        audioRef.current = null;
        setLoadingTrackId("");
        setPlayingTrackId("");
      }
    };
    // Another player can pause this one when it takes over; the row must not
    // keep showing Stop for something that is no longer playing.
    audio.onpause = () => {
      if (audioRef.current === audio) setPlayingTrackId("");
    };

    try {
      const url = await onAudition(track);
      // A later click has taken over; this result is stale.
      if (audioRef.current !== audio) return;
      audio.src = url;
      claimAudio(audio);
      await audio.play();
      if (audioRef.current === audio) setPlayingTrackId(track.id);
    } catch {
      if (audioRef.current === audio) {
        disposeAudio(audio);
        audioRef.current = null;
        setPlayingTrackId("");
      }
    } finally {
      if (audioRef.current === audio) setLoadingTrackId("");
    }
  }
  return (
    <ol className="queue-list">
      {tracks.map((track, index) => {
        const hasVote = votedTrackIds.has(track.id);
        const isPending = pendingVotes.has(track.id);
        const played = Boolean(track.playedAt);
        const cooling = track.cooldown > 0;
        const onNow = track.id === nowPlayingTrackId;

        return (
          <li
            key={track.id}
            className={`${index === 0 && !cooling ? "is-leading" : ""}${cooling ? " is-played" : ""}`}
          >
            <span className="queue-rank">{String(index + 1).padStart(2, "0")}</span>
            {onAudition && track.previewUrl ? (
              <button
                type="button"
                className="queue-art preview-play"
                onClick={() => void toggleAudition(track)}
                aria-label={`${playingTrackId === track.id ? "Stop pre-listening to" : "Pre-listen to"} ${track.title}`}
                aria-pressed={playingTrackId === track.id}
              >
                {loadingTrackId === track.id ? (
                  <span className="preview-loader" aria-hidden="true" />
                ) : playingTrackId === track.id ? (
                  <Pause size={17} fill="currentColor" />
                ) : (
                  <Headphones size={18} strokeWidth={2.2} />
                )}
              </button>
            ) : (
              <span className="queue-art" aria-hidden="true">
                <AudioLines size={20} strokeWidth={1.7} />
              </span>
            )}
            <span className="track-copy">
              <strong>{track.title}</strong>
              <small>
                {track.artist}
                {cooling
                  ? ` · cooldown: ${track.cooldown} more song${track.cooldown === 1 ? "" : "s"}`
                  : played
                    ? " · played"
                    : ""}
              </small>
              <VoterStack voters={track.voters} votes={track.votes} />
            </span>
            {interactive ? (
              <button
                type="button"
                className={`vote-button ${hasVote ? "has-vote" : ""}`}
                onClick={() => onVote?.(track.id)}
                disabled={cooling || isPending || (lockSelectedVotes && hasVote)}
                aria-label={`${hasVote ? lockSelectedVotes ? "Vote saved for" : "Remove vote from" : "Vote for"} ${track.title}, ${track.votes} ${track.votes === 1 ? "vote" : "votes"}`}
                aria-pressed={hasVote}
              >
                {isPending ? (
                  <span className="vote-pulse" aria-hidden="true" />
                ) : (
                  <ArrowUp size={17} strokeWidth={2.4} />
                )}
                <span>{track.votes}</span>
              </button>
            ) : onPlay ? (
              <span className="track-actions">
                <span className="vote-total">
                  <ArrowUp size={16} /> {track.votes}
                </span>
                {onNow ? (
                  <span className="row-on-now">
                    <AudioLines size={14} aria-hidden="true" /> On now
                  </span>
                ) : (
                  <button
                    type="button"
                    className="row-play"
                    disabled={isChangingTrack}
                    onClick={() => onPlay(track)}
                    aria-label={`Play ${track.title}${cooling ? " (on cooldown)" : ""}`}
                  >
                    <Play size={14} fill="currentColor" /> Play
                  </button>
                )}
              </span>
            ) : (
              <span className="vote-total">
                <ArrowUp size={16} /> {track.votes}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function IdentityGate({
  joiningRoom,
  afterFreeVote = false,
  onSave,
  onLogin,
}: {
  joiningRoom: boolean;
  afterFreeVote?: boolean;
  onSave: (phone: string, pseudonym: string) => Promise<void>;
  onLogin: (phone: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"create" | "login">("create");
  const [phone, setPhone] = useState("");
  const [pseudonym, setPseudonym] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState("");

  async function submitIdentity(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setFormError("");
    try {
      if (mode === "login") {
        await onLogin(phone);
      } else {
        await onSave(phone, pseudonym);
      }
    } catch (saveError) {
      setFormError(getErrorMessage(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="identity-page page-shell">
      <section className="identity-intro">
        {/* This is the landing page for a curator or DJ arriving cold, so the
            headline sells the product and the form beside it is the way in.
            A fan who followed a session link gets a lighter welcome. */}
        <span className="eyebrow">
          <UserRound size={14} /> {mode === "login"
            ? "Welcome back"
            : afterFreeVote
              ? "Keep voting"
              : joiningRoom
                ? "Join the session"
                : "For music curators and DJs"}
        </span>
        <h1>
          {mode === "login"
            ? "Log in by phone."
            : afterFreeVote
              ? "Your first vote is in."
              : joiningRoom
                ? "Pick a name."
                : "You curate."}
          <span>
            {mode === "login"
              ? "Continue on this device."
              : afterFreeVote
                ? "Add your phone to vote again."
                : joiningRoom
                  ? "Then bid on what plays next."
                  : "Your fans decide what to play next."}
          </span>
        </h1>
        {/* The headline carries the pitch; only logging in and keep-voting
            need a line of explanation. */}
        {mode === "login" ? (
          <p>Enter the phone number linked to your account.</p>
        ) : afterFreeVote ? (
          <p>
            Your free vote stays in the queue. Add a private phone number and
            pseudonym to make another pick.
          </p>
        ) : null}
      </section>

      <form className="identity-form" onSubmit={submitIdentity}>
        <div className="identity-form-mark" aria-hidden="true">
          <Phone size={28} strokeWidth={1.7} />
        </div>
        <label className="field">
          <span>Phone number</span>
          <input
            type="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="+32 470 00 00 00"
            autoComplete="tel"
            inputMode="tel"
            required
          />
          <small>Include your country code.</small>
        </label>
        {mode === "create" && (
          <label className="field">
            <span>Pseudonym</span>
            <input
              type="text"
              value={pseudonym}
              onChange={(event) => setPseudonym(event.target.value)}
              placeholder="Night Owl"
              autoComplete="nickname"
              minLength={2}
              maxLength={24}
              required
            />
            <small>Between 2 and 24 characters.</small>
          </label>
        )}
        {formError && <p className="form-error" role="alert">{formError}</p>}
        <button
          type="submit"
          className="primary-button identity-submit"
          disabled={isSaving}
        >
          {isSaving
            ? mode === "login"
              ? "Logging in..."
              : "Saving profile..."
            : mode === "login"
              ? "Log in"
              : afterFreeVote
                ? "Save and vote again"
                : joiningRoom
                  ? "Join room"
                  : "Continue"}
          <ArrowRight size={18} />
        </button>
        <p className="identity-switch">
          {mode === "login" ? "Need an account?" : "Already have an account?"}
          <button
            type="button"
            onClick={() => {
              setMode((current) =>
                current === "login" ? "create" : "login",
              );
              setFormError("");
            }}
          >
            {mode === "login" ? "Create one" : "Log in"}
          </button>
        </p>
      </form>
    </main>
  );
}

function LoadingRoom({
  label,
  error,
  onRetry,
}: {
  label: string;
  error?: string;
  onRetry?: () => void;
}) {
  return (
    <main className="loading-room page-shell" aria-live="polite">
      <div className="loading-mark">
        <span />
        <span />
        <span />
      </div>
      <strong>{label}</strong>
      {error ? (
        <p role="alert" className="loading-error">
          {error} Retrying...
          {onRetry ? (
            <>
              {" "}
              <button type="button" className="link-button" onClick={onRetry}>
                Try again now
              </button>
            </>
          ) : null}
        </p>
      ) : (
        <p>Syncing the latest queue...</p>
      )}
      <div className="loading-rows" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </main>
  );
}

function MissingRoom({
  isHost = false,
  onReset,
}: {
  isHost?: boolean;
  onReset?: () => void;
}) {
  return (
    <main className="missing-room page-shell">
      <span className="missing-code">404 / OFF AIR</span>
      <h1>This room has ended.</h1>
      <p>
        {isHost
          ? "The room expired or was closed. Start a fresh session to continue."
          : "Ask the DJ for a fresh QR code to rejoin the queue."}
      </p>
      {isHost && onReset && (
        <button type="button" className="primary-button" onClick={onReset}>
          Start a new session <ArrowRight size={18} />
        </button>
      )}
    </main>
  );
}

function ConnectionRoom() {
  return (
    <main className="missing-room page-shell">
      <span className="missing-code">RECONNECTING</span>
      <h1>Trying to reach the room.</h1>
      <p>Keep this page open. The queue will reconnect automatically.</p>
    </main>
  );
}

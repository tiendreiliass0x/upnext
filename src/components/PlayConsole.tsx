"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ListMusic,
  Pause,
  Play,
  Plus,
  SkipBack,
  SkipForward,
  Trash2,
  X,
} from "lucide-react";
import type { CatalogueTrack } from "@/lib/libraries";
import type { Playlist, PlaylistTrack } from "@/lib/playlists";

const accountTokenStorageKey = "upnext-account-token";

type Row = CatalogueTrack | PlaylistTrack;
type View = { kind: "search" } | { kind: "playlist"; id: string };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`The server sent an unexpected response (${response.status}).`);
  }
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export default function PlayConsole() {
  const [token, setToken] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [view, setView] = useState<View>({ kind: "search" });
  const [rows, setRows] = useState<Row[]>([]);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  // Player
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<Row[]>([]);
  const [current, setCurrent] = useState<Row | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLoadingTrack, setIsLoadingTrack] = useState(false);

  useEffect(() => {
    try {
      setToken(window.localStorage.getItem(accountTokenStorageKey) ?? "");
    } catch {
      setToken("");
    }
  }, []);

  const authHeaders = useCallback(
    () => ({ Authorization: `Bearer ${token ?? ""}` }),
    [token],
  );

  const loadPlaylists = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch("/api/playlists", {
        cache: "no-store",
        headers: authHeaders(),
      });
      const data = await readJson<{ playlists?: Playlist[]; error?: string }>(response);
      if (!response.ok || !data.playlists) {
        throw new Error(data.error || "Playlists could not be loaded.");
      }
      setPlaylists(data.playlists);
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, [authHeaders, token]);

  useEffect(() => {
    void loadPlaylists();
  }, [loadPlaylists]);

  // Rows follow the view: catalogue search, or one playlist's contents.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        void (async () => {
          try {
            const url =
              view.kind === "search"
                ? `/api/catalogue?q=${encodeURIComponent(query)}`
                : `/api/playlists/${encodeURIComponent(view.id)}`;
            const response = await fetch(url, {
              cache: "no-store",
              headers: authHeaders(),
            });
            const data = await readJson<{
              tracks?: Row[];
              error?: string;
            }>(response);
            if (!response.ok || !data.tracks) {
              throw new Error(data.error || "Songs could not be loaded.");
            }
            if (!cancelled) {
              setRows(data.tracks);
              setError("");
            }
          } catch (loadError) {
            if (!cancelled) setError(errorMessage(loadError));
          }
        })();
      },
      view.kind === "search" && query ? 250 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [authHeaders, query, token, view]);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    setIsPlaying(false);
    setCurrent(null);
    setPosition(0);
    setDuration(0);
  }, []);

  const playAt = useCallback(
    async (list: Row[], index: number) => {
      const track = list[index];
      if (!track || !track.previewUrl) return;

      setQueue(list);
      setCurrent(track);
      setIsLoadingTrack(true);
      setError("");
      try {
        // The preview route is account-gated, and an <audio> element cannot
        // send a bearer header, so ask for the signed URL and set that.
        const response = await fetch(`${track.previewUrl}?as=json`, {
          cache: "no-store",
          headers: authHeaders(),
        });
        const data = await readJson<{ url?: string; error?: string }>(response);
        if (!response.ok || !data.url) {
          throw new Error(data.error || "This preview could not be loaded.");
        }
        const audio = audioRef.current;
        if (!audio) return;
        audio.src = data.url;
        await audio.play();
        setIsPlaying(true);
      } catch (playError) {
        setError(errorMessage(playError));
        setIsPlaying(false);
      } finally {
        setIsLoadingTrack(false);
      }
    },
    [authHeaders],
  );

  function toggleRow(list: Row[], index: number) {
    const track = list[index];
    if (current?.id === track.id) {
      const audio = audioRef.current;
      if (!audio) return;
      if (audio.paused) {
        void audio.play();
        setIsPlaying(true);
      } else {
        audio.pause();
        setIsPlaying(false);
      }
      return;
    }
    void playAt(list, index);
  }

  function step(delta: number) {
    if (!current) return;
    const index = queue.findIndex((row) => row.id === current.id);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= queue.length) return;
    void playAt(queue, next);
  }

  async function createPlaylist(event: React.FormEvent) {
    event.preventDefault();
    setIsBusy(true);
    try {
      const response = await fetch("/api/playlists", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      const data = await readJson<{ playlist?: Playlist; error?: string }>(response);
      if (!response.ok || !data.playlist) {
        throw new Error(data.error || "The playlist could not be created.");
      }
      setNewName("");
      await loadPlaylists();
      setView({ kind: "playlist", id: data.playlist.id });
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setIsBusy(false);
    }
  }

  async function addToPlaylist(playlistId: string, trackId: string) {
    setIsBusy(true);
    try {
      const response = await fetch(
        `/api/playlists/${encodeURIComponent(playlistId)}/tracks`,
        {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ trackId }),
        },
      );
      if (!response.ok) {
        const data = await readJson<{ error?: string }>(response);
        throw new Error(data.error || "The song could not be added.");
      }
      await loadPlaylists();
    } catch (addError) {
      setError(errorMessage(addError));
    } finally {
      setIsBusy(false);
    }
  }

  async function removeFromPlaylist(playlistId: string, trackId: string) {
    setIsBusy(true);
    try {
      const response = await fetch(
        `/api/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(trackId)}`,
        { method: "DELETE", headers: authHeaders() },
      );
      if (!response.ok) {
        const data = await readJson<{ error?: string }>(response);
        throw new Error(data.error || "The song could not be removed.");
      }
      setRows((list) => list.filter((row) => row.id !== trackId));
      await loadPlaylists();
    } catch (removeError) {
      setError(errorMessage(removeError));
    } finally {
      setIsBusy(false);
    }
  }

  async function removePlaylist(playlist: Playlist) {
    setIsBusy(true);
    try {
      const response = await fetch(
        `/api/playlists/${encodeURIComponent(playlist.id)}`,
        { method: "DELETE", headers: authHeaders() },
      );
      if (!response.ok) throw new Error("The playlist could not be deleted.");
      if (view.kind === "playlist" && view.id === playlist.id) {
        setView({ kind: "search" });
      }
      await loadPlaylists();
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setIsBusy(false);
    }
  }

  if (token === null) return null;

  if (!token) {
    return (
      <div className="upnext-app">
        <header className="app-header">
          <span className="wordmark">
            <span className="wordmark-dot" aria-hidden="true" />
            UP/NEXT
          </span>
        </header>
        <main className="page-shell">
          <p className="library-empty">
            Sign in from the booth first — the catalogue is not public.{" "}
            <Link href="/">Open the booth</Link>
          </p>
        </main>
      </div>
    );
  }

  const activePlaylist =
    view.kind === "playlist"
      ? playlists.find((item) => item.id === view.id) ?? null
      : null;

  return (
    <div className={`upnext-app ${current ? "has-dock" : ""}`}>
      <header className="app-header">
        <Link className="wordmark" href="/">
          <span className="wordmark-dot" aria-hidden="true" />
          UP/NEXT
        </Link>
        <Link className="text-button" href="/">
          <ArrowLeft size={15} /> Booth
        </Link>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError("")} aria-label="Dismiss">
            <X size={18} />
          </button>
        </div>
      )}

      <main className="page-shell play-layout">
        <aside className="play-sidebar">
          <h2>Playlists</h2>
          <form className="play-new" onSubmit={createPlaylist}>
            <input
              type="text"
              value={newName}
              maxLength={80}
              required
              placeholder="New playlist"
              aria-label="New playlist name"
              onChange={(event) => setNewName(event.target.value)}
            />
            <button type="submit" className="primary-button" disabled={isBusy}>
              <Plus size={15} />
            </button>
          </form>

          <ul className="play-playlists">
            <li className={view.kind === "search" ? "is-active" : ""}>
              <button type="button" onClick={() => setView({ kind: "search" })}>
                <ListMusic size={15} />
                <span className="track-copy">
                  <strong>Catalogue</strong>
                  <small>Search everything</small>
                </span>
              </button>
            </li>
            {playlists.map((playlist) => (
              <li
                key={playlist.id}
                className={
                  view.kind === "playlist" && view.id === playlist.id ? "is-active" : ""
                }
              >
                <button
                  type="button"
                  onClick={() => setView({ kind: "playlist", id: playlist.id })}
                >
                  <ListMusic size={15} />
                  <span className="track-copy">
                    <strong>{playlist.name}</strong>
                    <small>
                      {playlist.trackCount} song{playlist.trackCount === 1 ? "" : "s"}
                    </small>
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Delete ${playlist.name}`}
                  disabled={isBusy}
                  onClick={() => void removePlaylist(playlist)}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="play-main">
          <div className="play-main-head">
            <h1>{activePlaylist ? activePlaylist.name : "Catalogue"}</h1>
            {activePlaylist && rows.length > 0 && (
              <Link
                className="primary-button"
                href={`/?playlist=${encodeURIComponent(activePlaylist.id)}`}
              >
                Start a room from this playlist
              </Link>
            )}
            {view.kind === "search" && (
              <input
                type="search"
                className="library-search"
                placeholder="Search title or artist"
                aria-label="Search the catalogue"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            )}
          </div>

          {rows.length === 0 ? (
            <p className="library-empty">
              {view.kind === "search"
                ? query
                  ? "No songs match that search."
                  : "The catalogue is empty."
                : "This playlist has no songs yet. Find some in the catalogue."}
            </p>
          ) : (
            <ol className="play-rows">
              {rows.map((row, index) => {
                const isCurrent = current?.id === row.id;
                return (
                  <li key={row.id} className={isCurrent ? "is-current" : ""}>
                    <button
                      type="button"
                      className="play-row-button"
                      disabled={!row.previewUrl}
                      aria-label={`${isCurrent && isPlaying ? "Pause" : "Play"} ${row.title}`}
                      onClick={() => toggleRow(rows, index)}
                    >
                      {isCurrent && isPlaying ? <Pause size={16} /> : <Play size={16} />}
                    </button>
                    <span className="track-copy">
                      <strong>{row.title}</strong>
                      <small>
                        {row.artist} · {row.libraryName}
                        {row.previewUrl ? "" : " · no preview"}
                      </small>
                    </span>
                    {view.kind === "search" ? (
                      playlists.length > 0 && (
                        <select
                          className="play-add"
                          aria-label={`Add ${row.title} to a playlist`}
                          value=""
                          disabled={isBusy}
                          onChange={(event) => {
                            if (event.target.value) {
                              void addToPlaylist(event.target.value, row.id);
                              event.target.value = "";
                            }
                          }}
                        >
                          <option value="">Add to…</option>
                          {playlists.map((playlist) => (
                            <option key={playlist.id} value={playlist.id}>
                              {playlist.name}
                            </option>
                          ))}
                        </select>
                      )
                    ) : (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove ${row.title}`}
                        disabled={isBusy}
                        onClick={() =>
                          view.kind === "playlist" &&
                          void removeFromPlaylist(view.id, row.id)
                        }
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </main>

      <audio
        ref={audioRef}
        preload="none"
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onEnded={() => step(1)}
        onError={() => {
          setIsPlaying(false);
          setError("That preview could not be played.");
        }}
      />

      {current && (
        <div className="player-dock" role="region" aria-label="Now playing">
          <div className="player-dock-inner">
            <button
              type="button"
              className="icon-button"
              aria-label="Previous"
              onClick={() => step(-1)}
            >
              <SkipBack size={17} />
            </button>
            <button
              type="button"
              className="player-main-button"
              aria-label={isPlaying ? "Pause" : "Play"}
              onClick={() => {
                const audio = audioRef.current;
                if (!audio) return;
                if (audio.paused) {
                  void audio.play();
                  setIsPlaying(true);
                } else {
                  audio.pause();
                  setIsPlaying(false);
                }
              }}
            >
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Next"
              onClick={() => step(1)}
            >
              <SkipForward size={17} />
            </button>

            <span className="track-copy player-now">
              <strong>{current.title}</strong>
              <small>
                {current.artist}
                {isLoadingTrack ? " · loading" : ""}
              </small>
            </span>

            <span className="player-progress" aria-hidden="true">
              <span
                style={{
                  width: `${duration > 0 ? Math.min(100, (position / duration) * 100) : 0}%`,
                }}
              />
            </span>
            <span className="player-time">
              {formatTime(position)} / {formatTime(duration || 30)}
            </span>

            <button
              type="button"
              className="icon-button"
              aria-label="Close player"
              onClick={stop}
            >
              <X size={17} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Link2, Plus, Radio, Unlink } from "lucide-react";
import { fetchWithTimeout, readJson } from "@/lib/http-client";
import type {
  ProviderId,
  ProviderPlaylist,
  ProviderTrack,
} from "@/lib/providers/types";

type AvailableProvider = {
  provider: ProviderId;
  label: string;
  unavailableReason: string | null;
};

type Connection = {
  provider: ProviderId;
  label: string;
  displayName: string;
};

type ConnectionsPayload = {
  available?: AvailableProvider[];
  connections?: Connection[];
  error?: string;
};

const connectPollMs = 1500;
const connectTimeoutMs = 5 * 60 * 1000;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

/**
 * Pick songs from a service the DJ has connected.
 *
 * Deliberately the same shape as LibraryPicker sitting beside it — the same
 * classes, the same debounce, the same checkbox rows — because to the DJ this
 * is the same act with a different shelf, and it should not look like a
 * different app.
 *
 * The one thing it does differently is connecting, which has to survive the
 * draft list: the setup screen holds File objects for songs already dragged
 * in, and a File cannot cross an OAuth round trip. So the provider opens in a
 * popup and this page stays exactly where it is, watching for the connection
 * to appear.
 */
export default function SourcePicker({
  accountToken,
  disabled = false,
  onAdd,
}: {
  accountToken: string;
  disabled?: boolean;
  onAdd: (tracks: ProviderTrack[], provider: ProviderId) => void;
}) {
  const [available, setAvailable] = useState<AvailableProvider[] | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [playlists, setPlaylists] = useState<ProviderPlaylist[]>([]);
  const [playlistId, setPlaylistId] = useState("");
  const [tracks, setTracks] = useState<ProviderTrack[]>([]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const pollRef = useRef<number | null>(null);

  const authHeaders = useCallback(
    () => ({ Authorization: `Bearer ${accountToken}` }),
    [accountToken],
  );

  const loadConnections = useCallback(async () => {
    const response = await fetchWithTimeout("/api/connections", {
      cache: "no-store",
      headers: { Authorization: `Bearer ${accountToken}` },
    });
    const data = await readJson<ConnectionsPayload>(response);
    if (!response.ok || !data.available) throw new Error(data.error || "");
    return data;
  }, [accountToken]);

  useEffect(() => {
    if (!accountToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadConnections();
        if (cancelled) return;
        setAvailable(data.available ?? []);
        setConnections(data.connections ?? []);
      } catch {
        // Nothing configured, or the call failed: the picker simply does not
        // appear, the same way LibraryPicker hides with an empty catalogue.
        if (!cancelled) setAvailable([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountToken, loadConnections]);

  const connected = connections[0] ?? null;

  // Playlists follow the connection.
  useEffect(() => {
    if (!accountToken || !connected) {
      setPlaylists([]);
      setPlaylistId("");
      return;
    }
    let cancelled = false;
    void (async () => {
      setIsLoading(true);
      try {
        const response = await fetchWithTimeout(
          `/api/connections/${connected.provider}/playlists`,
          { cache: "no-store", headers: { Authorization: `Bearer ${accountToken}` } },
        );
        const data = await readJson<{ playlists?: ProviderPlaylist[]; error?: string }>(
          response,
        );
        if (!response.ok || !data.playlists) {
          throw new Error(data.error || "Your playlists could not be read.");
        }
        if (cancelled) return;
        setPlaylists(data.playlists);
        setPlaylistId((current) => current || data.playlists?.[0]?.id || "");
        setPickerError("");
      } catch (error) {
        if (!cancelled) setPickerError(getErrorMessage(error));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountToken, connected]);

  // Tracks follow the chosen playlist, debounced exactly like the library
  // search beside it so typing does not fire a request per keystroke.
  useEffect(() => {
    if (!accountToken || !connected || !playlistId) {
      setTracks([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        setIsLoading(true);
        try {
          const response = await fetchWithTimeout(
            `/api/connections/${connected.provider}/playlists/${encodeURIComponent(playlistId)}/tracks?q=${encodeURIComponent(query)}`,
            { cache: "no-store", headers: { Authorization: `Bearer ${accountToken}` } },
          );
          const data = await readJson<{ tracks?: ProviderTrack[]; error?: string }>(
            response,
          );
          if (!response.ok || !data.tracks) {
            throw new Error(data.error || "Those songs could not be read.");
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
  }, [accountToken, connected, playlistId, query]);

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  function watchForConnection(popup: Window | null) {
    const startedAt = Date.now();
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => {
      void (async () => {
        if (Date.now() - startedAt > connectTimeoutMs) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          setIsConnecting(false);
          return;
        }
        try {
          const data = await loadConnections();
          if ((data.connections ?? []).length === 0) {
            // The DJ closing the window without finishing is an answer too.
            if (popup?.closed) {
              if (pollRef.current) window.clearInterval(pollRef.current);
              setIsConnecting(false);
            }
            return;
          }
          if (pollRef.current) window.clearInterval(pollRef.current);
          setAvailable(data.available ?? []);
          setConnections(data.connections ?? []);
          setIsConnecting(false);
          popup?.close();
        } catch {
          // Keep polling; a dropped request is not a failed connection.
        }
      })();
    }, connectPollMs);
  }

  async function connect(providerId: ProviderId) {
    setPickerError("");
    // Opened synchronously, before any await: a popup opened after one has
    // lost the click that authorised it and gets blocked.
    const popup = window.open(
      "/connect-done?status=pending",
      "upnext-connect",
      "width=520,height=720",
    );
    if (!popup) {
      setPickerError(
        "Allow pop-ups for this site to connect an account, then try again.",
      );
      return;
    }

    setIsConnecting(true);
    try {
      const response = await fetchWithTimeout(
        `/api/connections/${providerId}/start`,
        { method: "POST", headers: authHeaders() },
      );
      const data = await readJson<{ authorizeUrl?: string; error?: string }>(
        response,
      );
      if (!response.ok || !data.authorizeUrl) {
        throw new Error(data.error || "The connection could not be started.");
      }
      popup.location.replace(data.authorizeUrl);
      watchForConnection(popup);
    } catch (error) {
      popup.close();
      setIsConnecting(false);
      setPickerError(getErrorMessage(error));
    }
  }

  async function removeConnection(providerId: ProviderId) {
    setPickerError("");
    try {
      await fetchWithTimeout(`/api/connections/${providerId}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
    } catch {
      // Even a failed call should leave the UI honest; the reload decides.
    }
    try {
      const data = await loadConnections();
      setAvailable(data.available ?? []);
      setConnections(data.connections ?? []);
      setPicked(new Set());
    } catch (error) {
      setPickerError(getErrorMessage(error));
    }
  }

  // Nothing to show on a server with no music services set up.
  if (!accountToken || available === null || available.length === 0) return null;

  const offer = available[0];
  const selected = tracks.filter((track) => picked.has(track.providerTrackId));

  if (!connected) {
    return (
      <div className="library-picker">
        <div className="library-picker-head">
          <span className="eyebrow">
            <Radio size={14} /> Bring in your own music
          </span>
        </div>
        <p className="library-empty">
          {offer.unavailableReason ??
            `Connect ${offer.label} to build this room from playlists you already made.`}
        </p>
        {pickerError && <p className="form-error" role="alert">{pickerError}</p>}
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || isConnecting || Boolean(offer.unavailableReason)}
          onClick={() => void connect(offer.provider)}
        >
          <Link2 size={16} />
          {isConnecting ? "Waiting for sign-in..." : `Connect ${offer.label}`}
        </button>
      </div>
    );
  }

  return (
    <div className="library-picker">
      <div className="library-picker-head">
        <span className="eyebrow">
          <Radio size={14} /> {connected.label} · {connected.displayName}
        </span>
        {/* Held back until there is something in it: an empty select is a
            control that looks usable and is not. */}
        {playlists.length > 0 && (
          <select
            aria-label="Choose a playlist"
            value={playlistId}
            disabled={disabled}
            onChange={(event) => {
              setPlaylistId(event.target.value);
              setPicked(new Set());
            }}
          >
            {playlists.map((playlist) => (
              <option key={playlist.id} value={playlist.id}>
                {playlist.title}
                {playlist.trackCount === null ? "" : ` (${playlist.trackCount})`}
              </option>
            ))}
          </select>
        )}
      </div>

      <input
        type="search"
        className="library-search"
        placeholder="Search title or artist"
        aria-label="Search this playlist"
        value={query}
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
      />

      {pickerError && <p className="form-error" role="alert">{pickerError}</p>}

      {playlists.length === 0 ? (
        <p className="library-empty">
          {isLoading ? "Loading your playlists..." : "No playlists to show yet."}
        </p>
      ) : isLoading && tracks.length === 0 ? (
        <p className="library-empty">Loading songs...</p>
      ) : tracks.length === 0 ? (
        <p className="library-empty">
          {query ? "No songs match that search." : "This playlist is empty."}
        </p>
      ) : (
        <ul className="library-list">
          {tracks.map((track) => (
            <li key={track.providerTrackId}>
              <label>
                <input
                  type="checkbox"
                  checked={picked.has(track.providerTrackId)}
                  disabled={disabled}
                  onChange={() =>
                    setPicked((current) => {
                      const next = new Set(current);
                      if (next.has(track.providerTrackId)) {
                        next.delete(track.providerTrackId);
                      } else {
                        next.add(track.providerTrackId);
                      }
                      return next;
                    })
                  }
                />
                <span className="track-copy">
                  <strong>{track.title}</strong>
                  <small>{track.uploaderName}</small>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="source-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || selected.length === 0}
          onClick={() => {
            onAdd(selected, connected.provider);
            setPicked(new Set());
          }}
        >
          <Plus size={16} />
          {selected.length === 0
            ? "Select songs to add"
            : `Add ${selected.length} song${selected.length === 1 ? "" : "s"}`}
        </button>
        <button
          type="button"
          className="text-button"
          disabled={disabled}
          onClick={() => void removeConnection(connected.provider)}
        >
          <Unlink size={14} /> Disconnect
        </button>
      </div>
    </div>
  );
}

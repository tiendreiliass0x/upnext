"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ListMusic, Plus, Trash2, Upload, X } from "lucide-react";
import type { Library, LibraryTrack } from "@/lib/libraries";
import { fetchWithTimeout, readJson } from "@/lib/http-client";

const adminTokenStorageKey = "upnext-admin-token";
const accountTokenStorageKey = "upnext-account-token";

function readStorage(key: string) {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}


function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

async function fileFingerprint(file: File) {
  const input = new TextEncoder().encode(
    `${file.name}\u0000${file.size}\u0000${file.lastModified}`,
  );
  try {
    const digest = await crypto.subtle.digest("SHA-256", input);
    return Array.from(new Uint8Array(digest).slice(0, 16))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    // subtle is absent on insecure origins; a weaker hash still beats a
    // raw filename, and it only has to be stable and ASCII.
    let hash = 0;
    for (const byte of input) hash = (hash * 31 + byte) >>> 0;
    return `${hash.toString(16)}-${file.size}`;
  }
}


// How long one file gets before its upload is abandoned. Generous: a long
// track on venue wifi is slow, not stuck. Without any deadline a stalled
// connection never settles and the whole batch hangs on it.
const uploadTimeoutMs = 5 * 60_000;
// Attempts per file. Measured over the dev tunnel, a run of bulk uploads
// loses a meaningful share of connections at the transport layer, which is
// exactly the case a second attempt fixes. Retrying is safe because the
// upload id is an idempotency key: the server answers a repeat of an id it
// already stored with the stored key rather than taking a second copy.
const uploadAttempts = 3;

/**
 * Statuses worth another attempt. 429 is the server shedding load while
 * another upload is in flight, and 5xx is the server having a bad moment;
 * both pass. A rejected format, an oversized file or a full quota will be
 * rejected identically forever, so those fail the file immediately.
 */
function isRetryableStatus(status: number) {
  return status === 429 || status >= 500;
}

export default function AdminLibraries() {
  const [adminToken, setAdminToken] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [accountToken, setAccountToken] = useState("");
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setAdminToken(readStorage(adminTokenStorageKey));
    setAccountToken(readStorage(accountTokenStorageKey));
  }, []);

  const authHeaders = useCallback(
    (extra: Record<string, string> = {}) => ({
      "x-upnext-admin-token": adminToken,
      ...extra,
    }),
    [adminToken],
  );

  const loadLibraries = useCallback(async () => {
    if (!adminToken) return;
    try {
      const response = await fetch("/api/libraries", {
        cache: "no-store",
        headers: authHeaders(),
      });
      const data = await readJson<{
        libraries?: Library[];
        error?: string;
      }>(response);
      if (response.status === 401 || response.status === 403) {
        throw new Error("That admin token was not accepted.");
      }
      if (!response.ok || !data.libraries) {
        throw new Error(data.error || "Libraries could not be loaded.");
      }
      setLibraries(data.libraries);
      setSelectedId((current) => current || data.libraries?.[0]?.id || "");
      setError("");
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, [adminToken, authHeaders]);

  useEffect(() => {
    void loadLibraries();
  }, [loadLibraries]);

  const loadTracks = useCallback(async () => {
    if (!adminToken || !selectedId) {
      setTracks([]);
      return;
    }
    try {
      const response = await fetch(
        `/api/libraries/${encodeURIComponent(selectedId)}/tracks`,
        { cache: "no-store", headers: authHeaders() },
      );
      const data = await readJson<{
        tracks?: LibraryTrack[];
        error?: string;
      }>(response);
      if (!response.ok || !data.tracks) {
        throw new Error(data.error || "Songs could not be loaded.");
      }
      setTracks(data.tracks);
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, [adminToken, authHeaders, selectedId]);

  useEffect(() => {
    void loadTracks();
  }, [loadTracks]);

  function saveToken(value: string) {
    const next = value.trim();
    setAdminToken(next);
    try {
      if (next) window.localStorage.setItem(adminTokenStorageKey, next);
      else window.localStorage.removeItem(adminTokenStorageKey);
    } catch {
      // The token still works for this tab.
    }
  }

  async function addLibrary(event: React.FormEvent) {
    event.preventDefault();
    setIsBusy(true);
    setError("");
    try {
      const response = await fetch("/api/libraries", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ name, description }),
      });
      const data = await readJson<{
        library?: Library;
        error?: string;
      }>(response);
      if (!response.ok || !data.library) {
        throw new Error(data.error || "The library could not be created.");
      }
      setName("");
      setDescription("");
      setSelectedId(data.library.id);
      await loadLibraries();
      setStatus(`Created ${data.library.name}.`);
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setIsBusy(false);
    }
  }

  async function removeLibrary(library: Library) {
    // Deleting cascades to every song in it, and the trash icon sits beside
    // the select button, so a misclick must not wipe a curated catalogue.
    const songs = library.trackCount === 1 ? "1 song" : `${library.trackCount} songs`;
    if (!window.confirm(`Delete "${library.name}" and the ${songs} in it? This cannot be undone.`)) {
      return;
    }
    setIsBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/libraries/${encodeURIComponent(library.id)}`,
        { method: "DELETE", headers: authHeaders() },
      );
      if (!response.ok) {
        const data = await readJson<{ error?: string }>(response);
        throw new Error(data.error || "The library could not be deleted.");
      }
      if (selectedId === library.id) setSelectedId("");
      await loadLibraries();
      setStatus(`Deleted ${library.name}.`);
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setIsBusy(false);
    }
  }

  // Audio goes through the same upload pipeline as a DJ's own files, so the
  // catalogue gets a real audio file and a real contributor.
  async function uploadSongs(files: FileList | null) {
    if (!files || files.length === 0 || !selectedId) return;
    if (!accountToken) {
      setError(
        "Sign in on the main app first. Uploading audio uses your normal account, so the preview has an owner.",
      );
      return;
    }

    setIsBusy(true);
    setError("");
    const list = Array.from(files);
    // One bad file must not abandon the rest of the batch, or the operator
    // re-drops everything and re-uploads what already landed.
    const failures: string[] = [];
    try {
      for (let index = 0; index < list.length; index += 1) {
        const file = list[index];
        try {
          await uploadOne(file, (attempt) => {
            setStatus(
              `Creating preview ${index + 1} of ${list.length}` +
                (attempt > 1 ? ` (retry ${attempt - 1})` : ""),
            );
          });
        } catch (fileError) {
          failures.push(`${file.name}: ${errorMessage(fileError)}`);
        }
      }
      // Refresh before reporting, not after: a successful loadLibraries
      // clears the error banner, which would wipe this batch's own list of
      // what failed. Silently dropping a file the operator watched fail is
      // worse than any of the failures.
      await Promise.all([loadTracks(), loadLibraries()]);
      const added = list.length - failures.length;
      setStatus(`Added ${added} song${added === 1 ? "" : "s"}.`);
      if (failures.length > 0) {
        setError(
          `${failures.length} of ${list.length} could not be added.\n${failures.join("\n")}`,
        );
      }
    } catch (uploadError) {
      setError(errorMessage(uploadError));
    } finally {
      setIsBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function sendUpload(
    file: File,
    uploadId: string,
    onAttempt: (attempt: number) => void,
  ) {
    let lastError = "could not be processed.";
    for (let attempt = 1; attempt <= uploadAttempts; attempt += 1) {
      onAttempt(attempt);
      try {
        const form = new FormData();
        form.append("file", file);
        const uploaded = await fetchWithTimeout(
          "/api/uploads",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accountToken}`,
              // Header values must be Latin-1 and the server ignores IDs over
              // 100 characters, so a filename cannot go in directly: a
              // Japanese title would throw before the request left the
              // browser and a long one would silently lose idempotency. A
              // hash of the same inputs is short, ASCII, and stable across a
              // re-drop of the same file.
              "x-upnext-upload-id": uploadId,
            },
            body: form,
          },
          uploadTimeoutMs,
        );
        const uploadData = await readJson<{
          previewKey?: string;
          error?: string;
        }>(uploaded);
        if (uploaded.ok && uploadData.previewKey) return uploadData.previewKey;
        lastError = uploadData.error || lastError;
        if (!isRetryableStatus(uploaded.status)) break;
      } catch (requestError) {
        // A dropped or timed-out connection: nothing was learned about the
        // file itself, so it is worth another go.
        lastError = errorMessage(requestError);
      }
      if (attempt < uploadAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
    throw new Error(lastError);
  }

  async function uploadOne(file: File, onAttempt: (attempt: number) => void) {
    // Fingerprint the file so a retry after a failure matches the first
    // attempt's idempotency key.
    const uploadId = `admin-${selectedId}-${await fileFingerprint(file)}`;
    const previewKey = await sendUpload(file, uploadId, onAttempt);

    const base = file.name.replace(/\.[^.]+$/, "");
    const [maybeArtist, ...rest] = base.split(" - ");
    const added = await fetchWithTimeout(
      `/api/libraries/${encodeURIComponent(selectedId)}/tracks`,
      {
        method: "POST",
        headers: authHeaders({
          "Content-Type": "application/json",
          Authorization: `Bearer ${accountToken}`,
        }),
        body: JSON.stringify({
          title: rest.length > 0 ? rest.join(" - ") : base,
          artist: rest.length > 0 ? maybeArtist : "Unknown artist",
          previewKey,
        }),
      },
    );
    if (!added.ok) {
      const data = await readJson<{ error?: string }>(added);
      throw new Error(data.error || "could not be catalogued.");
    }
  }

  async function removeTrack(track: LibraryTrack) {
    setIsBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/library-tracks/${encodeURIComponent(track.id)}`,
        { method: "DELETE", headers: authHeaders() },
      );
      if (!response.ok) {
        const data = await readJson<{ error?: string }>(response);
        throw new Error(data.error || "The song could not be removed.");
      }
      await Promise.all([loadTracks(), loadLibraries()]);
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setIsBusy(false);
    }
  }

  if (!adminToken) {
    return (
      <div className="upnext-app">
        <header className="app-header">
          <span className="wordmark">
            <span className="wordmark-dot" aria-hidden="true" />
            YOU/NEXT admin
          </span>
        </header>
        <main className="identity-page page-shell">
          <section className="identity-intro">
            <span className="eyebrow">Restricted</span>
            <h1>
              Admin token
              <span>Kept in this browser only.</span>
            </h1>
          </section>
          <form
            className="identity-form"
            onSubmit={(event) => {
              event.preventDefault();
              saveToken(tokenDraft);
            }}
          >
            <label className="field">
              <span>Admin token</span>
              <input
                type="password"
                value={tokenDraft}
                autoComplete="off"
                onChange={(event) => setTokenDraft(event.target.value)}
                required
              />
            </label>
            <button type="submit" className="primary-button identity-submit">
              Unlock
            </button>
          </form>
        </main>
      </div>
    );
  }

  const selected = libraries.find((library) => library.id === selectedId) ?? null;

  return (
    <div className="upnext-app">
      <header className="app-header">
        <span className="wordmark">
          <span className="wordmark-dot" aria-hidden="true" />
          YOU/NEXT admin
        </span>
        <button type="button" className="text-button" onClick={() => saveToken("")}>
          Lock
        </button>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError("")} aria-label="Dismiss">
            <X size={18} />
          </button>
        </div>
      )}

      <main className="page-shell admin-page">
        <section className="admin-panel">
          <div className="admin-panel-body">
            <h2>Libraries</h2>
            <form className="admin-inline-form" onSubmit={addLibrary}>
              <label className="field">
                <span>Name</span>
                <input
                  type="text"
                  value={name}
                  maxLength={80}
                  required
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Description <small>optional</small></span>
                <input
                  type="text"
                  value={description}
                  maxLength={200}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <button type="submit" className="primary-button" disabled={isBusy}>
                <Plus size={16} /> Create
              </button>
            </form>

            {libraries.length === 0 ? (
              <p className="library-empty">No libraries yet.</p>
            ) : (
              <ul className="admin-library-list">
                {libraries.map((library) => (
                  <li
                    key={library.id}
                    className={library.id === selectedId ? "is-active" : ""}
                  >
                    <button type="button" onClick={() => setSelectedId(library.id)}>
                      <ListMusic size={15} />
                      <span className="track-copy">
                        <strong>{library.name}</strong>
                        <small>
                          {library.trackCount} song
                          {library.trackCount === 1 ? "" : "s"}
                          {library.description ? ` · ${library.description}` : ""}
                        </small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Delete ${library.name}`}
                      disabled={isBusy}
                      onClick={() => void removeLibrary(library)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {selected && (
          <section className="admin-panel">
            <div className="admin-panel-body">
              <h2>{selected.name}</h2>
              {!accountToken && (
                <p className="link-warning" role="status">
                  <strong>Sign in to upload.</strong>
                  <span>
                    Audio uploads run through your normal account so each preview
                    has an owner. Open the main app, sign in, then come back.
                  </span>
                </p>
              )}
              <label className="secondary-button admin-upload">
                <Upload size={16} /> Add songs
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="audio/*"
                  disabled={isBusy || !accountToken}
                  onChange={(event) => void uploadSongs(event.target.files)}
                />
              </label>
              {status && <p className="library-empty">{status}</p>}

              {tracks.length === 0 ? (
                <p className="library-empty">No songs in this library yet.</p>
              ) : (
                <>
                <p className="admin-track-count">
                  {tracks.length} song{tracks.length === 1 ? "" : "s"}
                </p>
                <ul className="admin-track-list">
                  {tracks.map((track) => (
                    <li key={track.id}>
                      <span className="track-copy">
                        <strong>{track.title}</strong>
                        <small>
                          {track.artist}
                          {track.previewUrl ? "" : " · no audio"}
                        </small>
                      </span>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove ${track.title}`}
                        disabled={isBusy}
                        onClick={() => void removeTrack(track)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </li>
                  ))}
                </ul>
                </>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

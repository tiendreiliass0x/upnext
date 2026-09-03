"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ListMusic, Plus, Trash2, Upload, X } from "lucide-react";
import type { AccountStatus } from "@/lib/accounts";
import type { Library, LibraryTrack } from "@/lib/libraries";
import { fetchWithTimeout, readJson } from "@/lib/http-client";
import {
  accountTokenStorageKey,
  adminTokenHeader,
  adminTokenStorageKey,
} from "@/lib/tokens";


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

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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
// How long a file will sit waiting for the server to be free before it gives
// up. Sized against an upload rather than against a network hiccup: the thing
// being waited for is usually this batch's own previous file, which can take
// minutes on venue wifi.
const busyCeilingMs = 3 * 60_000;
// What to wait when the server says it is busy but not how long for.
const defaultBusyWaitMs = 5_000;
// Past this, a Retry-After is not the one-at-a-time gate clearing, it is the
// hourly limiter telling us to come back later. Waiting that out inside a
// batch would freeze the UI for an hour, so the file fails and says why.
const busyWaitCapMs = 60_000;

class UploadStillProcessingError extends Error {
  constructor() {
    super("The server is still processing this upload. Try this batch again in a few minutes.");
    this.name = "UploadStillProcessingError";
  }
}

/**
 * Statuses worth sending the file again. 5xx is the server having a bad
 * moment. 429 is deliberately absent: it means the server is busy rather
 * than that the transfer failed, and it is handled by waiting (see
 * `busyWaitMs`) instead of by spending one of the file's attempts. A
 * rejected format, an oversized file or a full quota will be rejected
 * identically forever, so those fail the file immediately.
 */
function isRetryableStatus(status: number) {
  return status >= 500;
}

function pause(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long the server asked us to wait, defaulting when it did not say, and
 * null when the wait is too long to sit through in the middle of a batch.
 */
function busyWaitMs(response: Response) {
  const seconds = Number(response.headers.get("retry-after"));
  if (!Number.isFinite(seconds) || seconds <= 0) return defaultBusyWaitMs;
  if (seconds * 1000 > busyWaitCapMs) return null;
  return Math.max(seconds * 1000, 1000);
}

export default function AdminLibraries() {
  const [adminToken, setAdminToken] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [accountToken, setAccountToken] = useState("");
  const [accounts, setAccounts] = useState<AccountStatus[]>([]);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const adminTokenRef = useRef("");
  // Bumped whenever the credential changes. Every admin read captures it
  // before its request and drops the response if it moved on, so an answer
  // fetched under the previous token cannot repopulate a panel that has since
  // been locked or pointed at a different one.
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    adminTokenRef.current = adminToken;
  }, [adminToken]);

  useEffect(() => {
    setAdminToken(readStorage(adminTokenStorageKey));
    setAccountToken(readStorage(accountTokenStorageKey));
  }, []);

  const authHeaders = useCallback(
    (extra: Record<string, string> = {}) => ({
      [adminTokenHeader]: adminToken,
      ...(accountToken ? { Authorization: `Bearer ${accountToken}` } : {}),
      ...extra,
    }),
    [accountToken, adminToken],
  );

  const loadLibraries = useCallback(async () => {
    if (!adminToken || adminTokenRef.current !== adminToken) return;
    const generation = loadGenerationRef.current;
    try {
      const response = await fetchWithTimeout("/api/libraries", {
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
      if (
        loadGenerationRef.current !== generation ||
        adminTokenRef.current !== adminToken
      ) {
        return;
      }
      setLibraries(data.libraries);
      setSelectedId((current) => current || data.libraries?.[0]?.id || "");
      setError("");
    } catch (loadError) {
      // The list on screen is the last one the server actually confirmed.
      // Clearing it here would drop the operator's chosen library, and the
      // next successful load re-selects the first shelf rather than theirs,
      // sending files to a library they never picked. saveToken already
      // clears both when the credential changes, which is the case where
      // what is on screen really is untrustworthy.
      setError(errorMessage(loadError));
    }
  }, [adminToken, authHeaders]);

  useEffect(() => {
    void loadLibraries();
  }, [loadLibraries]);

  const loadAccounts = useCallback(async () => {
    if (!adminToken || adminTokenRef.current !== adminToken) return;
    const generation = loadGenerationRef.current;
    try {
      const response = await fetchWithTimeout("/api/admin/accounts", {
        cache: "no-store",
        headers: authHeaders(),
      });
      const data = await readJson<{
        accounts?: AccountStatus[];
        error?: string;
      }>(response);
      if (!response.ok || !data.accounts) {
        throw new Error(data.error || "Account status could not be loaded.");
      }
      if (
        loadGenerationRef.current !== generation ||
        adminTokenRef.current !== adminToken
      ) {
        return;
      }
      setAccounts(data.accounts);
    } catch (loadError) {
      if (
        loadGenerationRef.current !== generation ||
        adminTokenRef.current !== adminToken
      ) {
        return;
      }
      setAccounts([]);
      setError(errorMessage(loadError));
    }
  }, [adminToken, authHeaders]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const loadTracks = useCallback(async () => {
    if (!adminToken || adminTokenRef.current !== adminToken || !selectedId) {
      setTracks([]);
      return;
    }
    const generation = loadGenerationRef.current;
    try {
      const response = await fetchWithTimeout(
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
      if (
        loadGenerationRef.current !== generation ||
        adminTokenRef.current !== adminToken
      ) {
        return;
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
    adminTokenRef.current = next;
    loadGenerationRef.current += 1;
    setAccounts([]);
    setLibraries([]);
    setSelectedId("");
    setTracks([]);
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
      const response = await fetchWithTimeout("/api/libraries", {
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
      const response = await fetchWithTimeout(
        `/api/libraries/${encodeURIComponent(library.id)}`,
        { method: "DELETE", headers: authHeaders() },
      );
      if (!response.ok) {
        const data = await readJson<{ error?: string }>(response);
        throw new Error(data.error || "The library could not be deleted.");
      }
      if (selectedId === library.id) setSelectedId("");
      await Promise.all([loadLibraries(), loadAccounts()]);
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
    // Songs the shelf already held. Not failures, but not additions either,
    // and an operator re-dropping a file to fix its title needs to be told
    // the catalogue kept the old one.
    const alreadyPresent: string[] = [];
    try {
      for (let index = 0; index < list.length; index += 1) {
        const file = list[index];
        try {
          const created = await uploadOne(file, (note) => {
            setStatus(
              `Creating preview ${index + 1} of ${list.length}` +
                (note ? ` (${note})` : ""),
            );
          });
          if (!created) alreadyPresent.push(file.name);
        } catch (fileError) {
          failures.push(`${file.name}: ${errorMessage(fileError)}`);
          if (fileError instanceof UploadStillProcessingError) {
            for (const waiting of list.slice(index + 1)) {
              failures.push(
                `${waiting.name}: not attempted because the previous upload is still processing.`,
              );
            }
            break;
          }
        }
      }
      // Refresh before reporting, not after: a successful loadLibraries
      // clears the error banner, which would wipe this batch's own list of
      // what failed. Silently dropping a file the operator watched fail is
      // worse than any of the failures.
      await Promise.all([loadTracks(), loadLibraries(), loadAccounts()]);
      const added = list.length - failures.length - alreadyPresent.length;
      setStatus(
        `Added ${added} song${added === 1 ? "" : "s"}.` +
          (alreadyPresent.length > 0
            ? ` ${alreadyPresent.length} already in this library, left as ${alreadyPresent.length === 1 ? "it was" : "they were"}: ${alreadyPresent.join(", ")}`
            : ""),
      );
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

  /**
   * Send one file, standing back up from the failures that are worth another
   * go. Two of them, and they are not the same thing:
   *
   *   - The transfer died or the proxy timed out. Ask for the idempotency ID's
   *     status first, and resend only when the server says it has no such job.
   *   - The server is busy finishing that upload. Poll without a file body
   *     until its stored key is ready, without spending another attempt.
   *
   * That distinction is the whole point. A large upload that the tunnel drops
   * leaves the server still finishing it — the object PUT is deliberately not
   * tied to the request. Re-sending the whole body then meets the one-at-a-time
   * gate and can strand every later file behind repeated waits. The status
   * request is tiny, and once it returns the stored key uploadOne can catalogue
   * the song without sending its audio again.
   */
  async function recoverUpload(
    uploadId: string,
    onProgress: (note: string) => void,
    budget: { waited: number },
    initialWait = 0,
  ) {
    let wait = initialWait;

    while (true) {
      if (wait > 0) {
        // The budget belongs to the file, not to this call: sendUpload asks
        // again on every attempt, and a fresh allowance each time would let
        // one file hold the batch for several multiples of the ceiling.
        if (budget.waited + wait > busyCeilingMs) {
          throw new UploadStillProcessingError();
        }
        budget.waited += wait;
        onProgress("server finishing upload");
        await pause(wait);
      }

      let response: Response;
      let data: { previewKey?: string; status?: string; error?: string };
      try {
        response = await fetchWithTimeout(
          `/api/uploads?requestId=${encodeURIComponent(uploadId)}`,
          {
            cache: "no-store",
            headers: authHeaders(),
          },
        );
        data = await readJson(response);
      } catch {
        // If even the lightweight check cannot get through, fall back to the
        // bounded POST retry rather than losing that retry to the status call.
        return null;
      }
      if (response.ok && data.previewKey) return data.previewKey;
      // Anything that is not "here it is" or "still working" says nothing
      // about the upload, and this runs inside sendUpload's own catch: a
      // throw here would escape the retry loop and replace the real upload
      // error with a status-check one. Hand the retry back instead.
      if (response.status !== 202) return null;
      wait = busyWaitMs(response) ?? defaultBusyWaitMs;
    }
  }

  async function sendUpload(
    file: File,
    uploadId: string,
    onProgress: (note: string) => void,
  ) {
    let lastError = "could not be processed.";
    // Shared with every recoverUpload call this file makes, so busyCeilingMs
    // means what it says: the total a single file waits on a busy server.
    const budget = { waited: 0 };
    let attempt = 1;
    while (attempt <= uploadAttempts) {
      onProgress(attempt > 1 ? `retry ${attempt - 1}` : "");
      try {
        const form = new FormData();
        form.append("file", file);
        const uploaded = await fetchWithTimeout(
          "/api/uploads",
          {
            method: "POST",
            headers: authHeaders({
              "x-upnext-upload-id": uploadId,
            }),
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
        if (uploaded.status === 429) {
          const wait = busyWaitMs(uploaded);
          // A wait longer than the cap is not the gate clearing, it is the
          // hourly limiter: stop and report what the server said.
          if (wait === null) break;
          // Out of patience with a gate that is not ours. The 429 says only
          // that the server is busy, and the two-at-a-time cap makes other
          // accounts' uploads a normal reason for it, so this file fails with
          // what the server said and the rest of the batch still gets its
          // turn. Only recoverUpload throws UploadStillProcessingError, and
          // only once the server has claimed this upload as in progress,
          // which is the one case where the next file cannot get in either.
          if (budget.waited + wait > busyCeilingMs) break;
          const recovered = await recoverUpload(uploadId, onProgress, budget, wait);
          if (recovered) return recovered;
          continue;
        }
        if (!isRetryableStatus(uploaded.status)) break;
        const recovered = await recoverUpload(uploadId, onProgress, budget);
        if (recovered) return recovered;
      } catch (requestError) {
        if (requestError instanceof UploadStillProcessingError) {
          throw requestError;
        }
        lastError = errorMessage(requestError);
        const recovered = await recoverUpload(uploadId, onProgress, budget);
        if (recovered) return recovered;
      }
      if (attempt < uploadAttempts) await pause(attempt * 1000);
      attempt += 1;
    }
    throw new Error(lastError);
  }

  async function uploadOne(file: File, onProgress: (note: string) => void) {
    // Fingerprint the file so a retry after a failure matches the first
    // attempt's idempotency key. It travels as a header, and header values
    // must be Latin-1 while the server ignores IDs over 100 characters, so a
    // filename cannot go in directly: a Japanese title would throw before the
    // request left the browser and a long one would silently lose
    // idempotency. A hash of the same inputs is short, ASCII, and stable
    // across a re-drop of the same file.
    const uploadId = `admin-${selectedId}-${await fileFingerprint(file)}`;
    const previewKey = await sendUpload(file, uploadId, onProgress);

    const base = file.name.replace(/\.[^.]+$/, "");
    const [maybeArtist, ...rest] = base.split(" - ");
    const body = JSON.stringify({
      title: rest.length > 0 ? rest.join(" - ") : base,
      artist: rest.length > 0 ? maybeArtist : "Unknown artist",
      previewKey,
    });
    let lastError = "could not be catalogued.";
    for (let attempt = 1; attempt <= uploadAttempts; attempt += 1) {
      onProgress(attempt > 1 ? `saving to library, retry ${attempt - 1}` : "saving to library");
      let added: Response;
      try {
        added = await fetchWithTimeout(
          `/api/libraries/${encodeURIComponent(selectedId)}/tracks`,
          {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body,
          },
        );
      } catch (requestError) {
        lastError = errorMessage(requestError);
        if (attempt < uploadAttempts) await pause(attempt * 1000);
        continue;
      }

      const data = await readJson<{ created?: boolean; error?: string }>(added);
      // 200 means the shelf already held this audio, so the row on it is
      // whatever it was called the first time. Reporting that as added would
      // tell the operator their corrected title landed when it did not.
      if (added.ok) return data.created !== false;
      lastError = data.error || lastError;
      if (!isRetryableStatus(added.status)) throw new Error(lastError);
      if (attempt < uploadAttempts) await pause(attempt * 1000);
    }
    throw new Error(lastError);
  }

  async function removeTrack(track: LibraryTrack) {
    setIsBusy(true);
    setError("");
    try {
      const response = await fetchWithTimeout(
        `/api/library-tracks/${encodeURIComponent(track.id)}`,
        { method: "DELETE", headers: authHeaders() },
      );
      if (!response.ok) {
        const data = await readJson<{ error?: string }>(response);
        throw new Error(data.error || "The song could not be removed.");
      }
      await Promise.all([loadTracks(), loadLibraries(), loadAccounts()]);
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
            <div className="admin-panel-heading">
              <h2>Accounts</h2>
              <span>{accounts.length} total</span>
            </div>
            {accounts.length === 0 ? (
              <p className="library-empty">No accounts yet.</p>
            ) : (
              <ul className="admin-account-list">
                {accounts.map((account) => (
                  <li key={account.id}>
                    <div className="admin-account-main">
                      <span className="track-copy">
                        <strong>{account.pseudonym}</strong>
                        <small>
                          Phone ending {account.phoneLast4} · Joined{" "}
                          {new Date(account.createdAt).toLocaleDateString()}
                        </small>
                      </span>
                      <span
                        className={`admin-account-state ${
                          account.activeRoomCount > 0 ? "is-live" : ""
                        }`}
                      >
                        {account.activeRoomCount > 0 ? "Live" : "Idle"}
                      </span>
                    </div>
                    <div className="admin-account-metrics">
                      <span><strong>{account.uploadCount}</strong> uploads</span>
                      <span><strong>{formatBytes(account.storageBytes)}</strong> stored</span>
                      <span><strong>{account.libraryTrackCount}</strong> library songs</span>
                      <span><strong>{account.playlistCount}</strong> playlists</span>
                    </div>
                    {account.uploadsNotInLibrary > 0 && (
                      <p className="admin-account-warning">
                        {account.uploadsNotInLibrary} upload
                        {account.uploadsNotInLibrary === 1 ? " is" : "s are"} not in a
                        library.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

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

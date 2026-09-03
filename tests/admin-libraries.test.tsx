// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AdminLibraries from "@/components/AdminLibraries";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

const library = { id: "lib-1", name: "Afrobeats", description: "", trackCount: 0 };

function mountWithUploads(
  uploadHandler: Handler,
  statusHandler: Handler = () =>
    Response.json({ status: "missing" }, { status: 404 }),
  catalogueHandler: Handler = () => Response.json({ track: { id: "t1" } }),
  accountHandler: Handler = () => Response.json({ accounts: [] }),
) {
  const uploadCalls: string[] = [];
  const statusCalls: string[] = [];
  const catalogued: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.startsWith("/api/uploads?")) {
        statusCalls.push(url);
        return statusHandler(url, init);
      }
      if (url === "/api/uploads") {
        uploadCalls.push(url);
        return uploadHandler(url, init);
      }
      if (url.endsWith("/tracks") && method === "POST") {
        catalogued.push(url);
        return catalogueHandler(url, init);
      }
      if (url.endsWith("/tracks")) return Response.json({ tracks: [] });
      if (url === "/api/admin/accounts") return accountHandler(url, init);
      if (url === "/api/libraries") return Response.json({ libraries: [library] });
      return Response.json({});
    }),
  );

  render(<AdminLibraries />);
  return { uploadCalls, statusCalls, catalogued };
}

async function dropFiles(names = ["Artist - Song.wav"]) {
  const input = await waitFor(() => {
    const node = document.querySelector<HTMLInputElement>(".admin-upload input");
    if (!node) throw new Error("no file input");
    return node;
  });
  const files = names.map(
    (name) => new File(["RIFF0000WAVE"], name, { type: "audio/wav" }),
  );
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
}

async function dropOneFile() {
  await dropFiles();
}

describe("catalogue uploads", () => {
  beforeEach(() => {
    window.localStorage.setItem("upnext-admin-token", "admin-token");
    window.localStorage.setItem("upnext-account-token", "account-token");
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("survives a connection the tunnel drops mid-batch", async () => {
    let attempts = 0;
    const { uploadCalls, catalogued } = mountWithUploads((_url, init) => {
      attempts += 1;
      expect(new Headers(init?.headers).get("x-upnext-admin-token")).toBe(
        "admin-token",
      );
      // The failure seen in practice: the connection dies with no response.
      if (attempts === 1) return Promise.reject(new TypeError("Failed to fetch"));
      return Response.json({ previewKey: "audio/a/b.wav" });
    });

    await dropOneFile();

    await waitFor(() => expect(screen.getByText("Added 1 song.")).toBeInTheDocument(), {
      timeout: 5000,
    });
    // Tried twice, catalogued once: the retry must not double-file the song.
    expect(uploadCalls).toHaveLength(2);
    expect(catalogued).toHaveLength(1);
  });

  it("fails only the file the gate refused, and lets the batch go on", async () => {
    // The gate is two uploads across the whole server, so another account can
    // hold it. The status check then answers 404 every time: this upload is
    // not one the server ever started, which is precisely why the file behind
    // it deserves its own turn rather than being written off unsent.
    let posts = 0;
    const { uploadCalls } = mountWithUploads(() => {
      posts += 1;
      return posts <= 4
        ? Response.json(
            { error: "Uploads are busy. Try again in a moment." },
            { status: 429, headers: { "Retry-After": "60" } },
          )
        : Response.json({ previewKey: "audio/a/second.wav" });
    });

    // Mounted on real timers, because the file input only appears once the
    // library list has loaded. The waiting is what needs a fake clock.
    const input = await waitFor(() => {
      const node = document.querySelector<HTMLInputElement>(".admin-upload input");
      if (!node) throw new Error("no file input");
      return node;
    });
    const files = ["Artist - busy.wav", "Artist - after.wav"].map(
      (name) => new File(["RIFF0000WAVE"], name, { type: "audio/wav" }),
    );
    Object.defineProperty(input, "files", { value: files, configurable: true });

    vi.useFakeTimers();
    try {
      fireEvent.change(input);
      // Past the three-minute ceiling the first file is given, with room for
      // the second to take its turn.
      await vi.advanceTimersByTimeAsync(8 * 60_000);
    } finally {
      vi.useRealTimers();
    }

    await waitFor(
      () => expect(screen.getByText(/Added 1 song\./)).toBeInTheDocument(),
      { timeout: 5000 },
    );
    const banner = screen.getByRole("alert").textContent ?? "";
    expect(banner).toContain("1 of 2 could not be added");
    expect(banner).toContain("Uploads are busy");
    // What it used to say instead, for every file behind the busy one.
    expect(banner).not.toContain("not attempted");
    expect(uploadCalls.length).toBeGreaterThan(4);
  });

  it("retries catalogue attachment without uploading the audio again", async () => {
    let catalogueAttempts = 0;
    const { uploadCalls, catalogued } = mountWithUploads(
      () => Response.json({ previewKey: "audio/a/attached-on-retry.wav" }),
      undefined,
      () => {
        catalogueAttempts += 1;
        return catalogueAttempts === 1
          ? Response.json({ error: "Database busy" }, { status: 503 })
          : Response.json({ track: { id: "t1" } });
      },
    );

    await dropOneFile();

    await waitFor(() => expect(screen.getByText("Added 1 song.")).toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(uploadCalls).toHaveLength(1);
    expect(catalogued).toHaveLength(2);
  });

  it("recovers a 524 from upload status instead of resending the file", async () => {
    let checks = 0;
    let uploads = 0;
    const { uploadCalls, statusCalls, catalogued } = mountWithUploads(
      () => {
        uploads += 1;
        return uploads === 1
          ? new Response("<html>timeout</html>", { status: 524 })
          : Response.json({ previewKey: "audio/a/next.wav" });
      },
      () => {
        checks += 1;
        return checks === 1
          ? Response.json(
              { status: "processing" },
              { status: 202, headers: { "Retry-After": "1" } },
            )
          : Response.json({ previewKey: "audio/a/recovered.wav" });
      },
    );

    await dropFiles(["Artist - First.wav", "Artist - Second.wav"]);

    await waitFor(() => expect(screen.getByText("Added 2 songs.")).toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(uploadCalls).toHaveLength(2);
    expect(statusCalls).toHaveLength(2);
    expect(catalogued).toHaveLength(2);
  });

  it(
    "waits out a busy server rather than spending the file's attempts",
    async () => {
      let attempts = 0;
      const { uploadCalls, catalogued } = mountWithUploads(() => {
        attempts += 1;
        // Bounced more times than a dropped transfer gets attempts. This is
        // the shape of the real failure: a large upload the tunnel drops
        // leaves the server finishing it, so every immediate re-send meets
        // the one-at-a-time gate until that first one lands.
        if (attempts <= 3) {
          return Response.json(
            { error: "Uploads are busy. Try again in a moment." },
            { status: 429, headers: { "Retry-After": "1" } },
          );
        }
        return Response.json({ previewKey: "audio/a/b.wav" });
      });

      await dropOneFile();

      await waitFor(
        () => expect(screen.getByText("Added 1 song.")).toBeInTheDocument(),
        { timeout: 15000 },
      );
      expect(uploadCalls).toHaveLength(4);
      expect(catalogued).toHaveLength(1);
    },
    20000,
  );

  it("does not sit through an hourly limit in the middle of a batch", async () => {
    const { uploadCalls } = mountWithUploads(() =>
      Response.json(
        { error: "Too many attempts. Try again in a few minutes." },
        { status: 429, headers: { "Retry-After": "900" } },
      ),
    );

    await dropOneFile();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Too many attempts");
    // Fifteen minutes is not a gate clearing. The file fails and says so
    // instead of freezing the batch behind it.
    expect(uploadCalls).toHaveLength(1);
  });

  it("does not retry a file the server will always reject", async () => {
    const { uploadCalls } = mountWithUploads(() =>
      Response.json({ error: "That file is not a supported audio format." }, { status: 415 }),
    );

    await dropOneFile();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not a supported audio format");
    // One attempt only: the answer would be identical every time.
    expect(uploadCalls).toHaveLength(1);
  });

  it("does not reveal an earlier account response after the admin token changes", async () => {
    let releaseAccounts: (response: Response) => void = () => {};
    let accountRequests = 0;
    mountWithUploads(
      () => Response.json({ previewKey: "audio/a/b.wav" }),
      undefined,
      undefined,
      () => {
        accountRequests += 1;
        if (accountRequests === 1) {
          return new Promise<Response>((resolve) => {
            releaseAccounts = resolve;
          });
        }
        return Response.json({ error: "Admin access required." }, { status: 403 });
      },
    );
    await waitFor(() => expect(accountRequests).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Lock" }));
    fireEvent.change(screen.getByLabelText("Admin token"), {
      target: { value: "invalid-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(accountRequests).toBe(2));

    releaseAccounts(
      Response.json({
        accounts: [
          {
            id: "account-1",
            pseudonym: "Private account",
            phoneLast4: "1234",
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
            uploadCount: 0,
            storageBytes: 0,
            libraryTrackCount: 0,
            uploadsNotInLibrary: 0,
            playlistCount: 0,
            activeRoomCount: 0,
          },
        ],
      }),
    );

    await waitFor(() =>
      expect(screen.queryByText("Private account")).not.toBeInTheDocument(),
    );
  });
});

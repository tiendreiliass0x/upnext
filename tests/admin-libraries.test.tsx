// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AdminLibraries from "@/components/AdminLibraries";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

const library = { id: "lib-1", name: "Afrobeats", description: "", trackCount: 0 };

function mountWithUploads(uploadHandler: Handler) {
  const uploadCalls: string[] = [];
  const catalogued: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url === "/api/uploads") {
        uploadCalls.push(url);
        return uploadHandler(url, init);
      }
      if (url.endsWith("/tracks") && method === "POST") {
        catalogued.push(url);
        return Response.json({ track: { id: "t1" } });
      }
      if (url.endsWith("/tracks")) return Response.json({ tracks: [] });
      if (url === "/api/libraries") return Response.json({ libraries: [library] });
      return Response.json({});
    }),
  );

  render(<AdminLibraries />);
  return { uploadCalls, catalogued };
}

async function dropOneFile() {
  const input = await waitFor(() => {
    const node = document.querySelector<HTMLInputElement>(".admin-upload input");
    if (!node) throw new Error("no file input");
    return node;
  });
  const file = new File(["RIFF0000WAVE"], "Artist - Song.wav", { type: "audio/wav" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
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
    const { uploadCalls, catalogued } = mountWithUploads(() => {
      attempts += 1;
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
});

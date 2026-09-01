// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PlayConsole from "@/components/PlayConsole";
import { previewSeconds } from "@/lib/preview";

const catalogue = [
  {
    id: "a", libraryId: "lib", title: "Alpha", artist: "One", libraryName: "L",
    previewUrl: "/api/library-tracks/a/preview", libraryPreviewKey: "k/a",
    contributedBy: null, createdAt: "",
  },
  {
    id: "b", libraryId: "lib", title: "Bravo", artist: "Two", libraryName: "L",
    previewUrl: "/api/library-tracks/b/preview", libraryPreviewKey: "k/b",
    contributedBy: null, createdAt: "",
  },
];

/** jsdom has no media playback; the component only needs the promises. */
function stubMedia() {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
}

/** jsdom's currentTime is read-only, so the position is stubbed in place. */
function seekTo(audio: HTMLAudioElement, seconds: number) {
  Object.defineProperty(audio, "currentTime", { value: seconds, configurable: true });
}

const libraries = [
  { id: "lib-house", name: "Deep House", description: "", trackCount: 2, createdAt: "" },
  { id: "lib-afro", name: "Afrobeats", description: "", trackCount: 0, createdAt: "" },
];

function mount(signedUrl: (id: string) => Promise<Response>) {
  window.localStorage.setItem("upnext-account-token", "host-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/playlists") return Response.json({ playlists: [] });
      if (url === "/api/libraries") return Response.json({ libraries });
      if (url.startsWith("/api/libraries/")) {
        // A shelf answers with its own tracks, which carry no library name.
        return Response.json({
          tracks: catalogue
            .filter(() => url.includes("lib-house"))
            .map((track) => {
              // A shelf answers without a library name; the view supplies it.
              const bare: Partial<typeof track> = { ...track };
              delete bare.libraryName;
              return bare;
            }),
        });
      }
      if (url.startsWith("/api/catalogue")) return Response.json({ tracks: catalogue });
      const preview = url.match(/^\/api\/library-tracks\/(\w+)\/preview\?as=json$/);
      if (preview) return signedUrl(preview[1]);
      return Response.json({ error: "unexpected" }, { status: 500 });
    }),
  );
  return render(<PlayConsole />);
}

beforeEach(() => {
  window.localStorage.clear();
  stubMedia();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the /play player", () => {
  it("ignores a slow signed-URL fetch once a later click has won", async () => {
    const user = userEvent.setup();
    let releaseAlpha: (response: Response) => void = () => {};
    const { container } = mount((id) =>
      id === "a"
        ? new Promise((resolve) => { releaseAlpha = resolve; })
        : Promise.resolve(Response.json({ url: `https://r2.example/${id}` })),
    );

    await user.click(await screen.findByRole("button", { name: "Play Alpha" }));
    await user.click(screen.getByRole("button", { name: "Play Bravo" }));
    // Alpha's signed URL arrives after Bravo already took over.
    releaseAlpha(Response.json({ url: "https://r2.example/a" }));
    await screen.findByText("Bravo", { selector: ".player-now strong" });

    const audio = container.querySelector("audio");
    expect(audio?.src).toBe("https://r2.example/b");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("plays a song right through instead of stopping at the taste", async () => {
    // /play is where a DJ listens to their own catalogue. The thirty-second
    // window belongs to the crowd's pre-listen in the booth; here a playlist
    // is meant to be listenable end to end.
    const user = userEvent.setup();
    const { container } = mount((id) =>
      Promise.resolve(Response.json({ url: `https://r2.example/${id}` })),
    );

    await user.click(await screen.findByRole("button", { name: "Play Alpha" }));
    const audio = container.querySelector("audio");
    if (!audio) throw new Error("no audio element");
    // jsdom has no playback clock, so the element is told where it is.
    seekTo(audio, previewSeconds + 5);
    fireEvent(audio, new Event("timeupdate"));

    expect(audio.pause).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Alpha", { selector: ".player-now strong" }),
    ).toBeInTheDocument();
  });

  it("counts the dock against the whole song, not a window", async () => {
    const user = userEvent.setup();
    const { container } = mount((id) =>
      Promise.resolve(Response.json({ url: `https://r2.example/${id}` })),
    );

    await user.click(await screen.findByRole("button", { name: "Play Alpha" }));
    const audio = container.querySelector("audio");
    if (!audio) throw new Error("no audio element");
    Object.defineProperty(audio, "duration", { configurable: true, value: 214 });
    fireEvent(audio, new Event("durationchange"));
    seekTo(audio, 60);
    fireEvent(audio, new Event("timeupdate"));

    // 3:34, the song -- not 0:30, the taste.
    expect(await screen.findByText("1:00 / 3:34")).toBeInTheDocument();
  });

  it("moves on when the song actually ends, and stops on the last row", async () => {
    const user = userEvent.setup();
    const { container } = mount((id) =>
      Promise.resolve(Response.json({ url: `https://r2.example/${id}` })),
    );

    await user.click(await screen.findByRole("button", { name: "Play Alpha" }));
    const audio = container.querySelector("audio");
    if (!audio) throw new Error("no audio element");
    fireEvent(audio, new Event("ended"));
    await screen.findByText("Bravo", { selector: ".player-now strong" });

    // Bravo is the last row: its ending leaves it where it is.
    fireEvent(audio, new Event("ended"));
    fireEvent(audio, new Event("pause"));
    expect(audio.src).toBe("https://r2.example/b");
    expect(
      screen.getByText("Bravo", { selector: ".player-now strong" }),
    ).toBeInTheDocument();
  });

  it("follows the element's own play and pause events", async () => {
    const user = userEvent.setup();
    const { container } = mount((id) =>
      Promise.resolve(Response.json({ url: `https://r2.example/${id}` })),
    );

    await user.click(await screen.findByRole("button", { name: "Play Alpha" }));
    const audio = container.querySelector("audio");
    if (!audio) throw new Error("no audio element");
    const dock = await screen.findByRole("region", { name: "Now playing" });

    // Nothing is assumed from calling play(): the state waits for the event.
    fireEvent(audio, new Event("play"));
    expect(dock.querySelector(".player-main-button")).toHaveAttribute("aria-label", "Pause");
    expect(screen.getByRole("button", { name: "Pause Alpha" })).toBeInTheDocument();

    // A track ending fires pause before ended, so the last song in a queue
    // leaves an honest Play button rather than a stuck Pause.
    fireEvent(audio, new Event("pause"));
    fireEvent(audio, new Event("ended"));
    expect(dock.querySelector(".player-main-button")).toHaveAttribute("aria-label", "Play");
    expect(screen.getByRole("button", { name: "Play Alpha" })).toBeInTheDocument();
  });
});

describe("browsing a catalogue in /play", () => {
  it("lists every uploaded catalogue, not just one flat pool", async () => {
    // The shelves the DJ uploaded were only ever grey text on a row; there
    // was nothing to click that said "Afrobeats".
    mount((id) => Promise.resolve(Response.json({ url: `https://r2.example/${id}` })));

    expect(
      await screen.findByRole("button", { name: /Deep House/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Afrobeats/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Everything/ })).toBeInTheDocument();
  });

  it("opens one catalogue on its own", async () => {
    const user = userEvent.setup();
    mount((id) => Promise.resolve(Response.json({ url: `https://r2.example/${id}` })));

    await user.click(await screen.findByRole("button", { name: /Deep House/ }));
    expect(
      await screen.findByRole("heading", { name: "Deep House", level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
  });

  it("searches inside a catalogue on the server", async () => {
    const user = userEvent.setup();
    mount((id) => Promise.resolve(Response.json({ url: `https://r2.example/${id}` })));

    await user.click(await screen.findByRole("button", { name: /Deep House/ }));
    const box = await screen.findByRole("searchbox", { name: "Search Deep House" });
    await user.type(box, "alph");

    await waitFor(() =>
      expect(
        (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
          (call) =>
            String(call[0]).startsWith("/api/libraries/lib-house/tracks?q=alph"),
        ),
      ).toBe(true),
    );
  });

  it("says a catalogue is empty rather than blaming the search", async () => {
    const user = userEvent.setup();
    mount((id) => Promise.resolve(Response.json({ url: `https://r2.example/${id}` })));

    await user.click(await screen.findByRole("button", { name: /Afrobeats/ }));
    expect(await screen.findByText("This catalogue is empty.")).toBeInTheDocument();
  });
});

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PlayConsole from "@/components/PlayConsole";

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

function mount(signedUrl: (id: string) => Promise<Response>) {
  window.localStorage.setItem("upnext-account-token", "host-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/playlists") return Response.json({ playlists: [] });
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

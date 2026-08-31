// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SourcePicker from "@/components/SourcePicker";

const available = [
  { provider: "soundcloud", label: "SoundCloud", unavailableReason: null },
];
const connection = {
  provider: "soundcloud",
  label: "SoundCloud",
  displayName: "DJ Owl",
};
const playlists = [
  { id: "likes", title: "Liked tracks", trackCount: null, artworkUrl: null },
  { id: "9", title: "Warmup", trackCount: 2, artworkUrl: null },
];
const tracks = [
  {
    providerTrackId: "soundcloud:tracks:111",
    title: "Night Bus",
    artist: "DJ Owl",
    artworkUrl: null,
    durationMs: 214_000,
    permalinkUrl: "https://soundcloud.com/djowl/night-bus",
    uploaderName: "DJ Owl",
    access: "playable",
  },
];

type Routes = {
  connections?: unknown;
  playlists?: unknown;
  tracks?: unknown;
  start?: unknown;
};

function stubFetch(routes: Routes) {
  const calls: string[] = [];
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const payload = url.includes("/start")
      ? routes.start
      : url.includes("/tracks")
        ? routes.tracks
        : url.includes("/playlists")
          ? routes.playlists
          : routes.connections;
    return new Response(JSON.stringify(payload ?? {}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return calls;
}

function connected(overrides: Routes = {}) {
  return stubFetch({
    connections: { available, connections: [connection] },
    playlists: { playlists },
    tracks: { tracks },
    ...overrides,
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SourcePicker", () => {
  it("renders nothing on a server with no music services set up", async () => {
    stubFetch({ connections: { available: [], connections: [] } });
    const { container } = render(
      <SourcePicker accountToken="t" onAdd={() => {}} />,
    );
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("offers to connect when the DJ has not linked an account", async () => {
    stubFetch({ connections: { available, connections: [] } });
    render(<SourcePicker accountToken="t" onAdd={() => {}} />);

    expect(
      await screen.findByRole("button", { name: "Connect SoundCloud" }),
    ).toBeEnabled();
  });

  it("explains itself instead of offering a dead button", async () => {
    stubFetch({
      connections: {
        available: [
          {
            provider: "soundcloud",
            label: "SoundCloud",
            unavailableReason: "Set APP_PUBLIC_URL before connecting an account.",
          },
        ],
        connections: [],
      },
    });
    render(<SourcePicker accountToken="t" onAdd={() => {}} />);

    expect(
      await screen.findByText("Set APP_PUBLIC_URL before connecting an account."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Connect SoundCloud/ })).toBeDisabled();
  });

  it("opens the sign-in in a popup so the draft set survives", async () => {
    // A redirect would take the setup screen with it, and the File objects
    // for songs already dragged in cannot come back.
    const popup = { location: { replace: vi.fn() }, close: vi.fn(), closed: false };
    const open = vi.fn(() => popup);
    vi.stubGlobal("open", open);
    stubFetch({
      connections: { available, connections: [] },
      start: { authorizeUrl: "https://secure.soundcloud.com/authorize?x=1" },
    });

    render(<SourcePicker accountToken="t" onAdd={() => {}} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Connect SoundCloud" }),
    );

    // Opened before the request, so the click that authorised it is not lost.
    expect(open).toHaveBeenCalled();
    await waitFor(() =>
      expect(popup.location.replace).toHaveBeenCalledWith(
        "https://secure.soundcloud.com/authorize?x=1",
      ),
    );
  });

  it("says so when the popup was blocked", async () => {
    vi.stubGlobal("open", vi.fn(() => null));
    stubFetch({ connections: { available, connections: [] } });

    render(<SourcePicker accountToken="t" onAdd={() => {}} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Connect SoundCloud" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/pop-ups/i);
  });

  it("lists the DJ's playlists once connected", async () => {
    connected();
    render(<SourcePicker accountToken="t" onAdd={() => {}} />);

    const picker = await screen.findByRole("combobox", { name: "Choose a playlist" });
    await waitFor(() => expect(picker).toHaveDisplayValue("Liked tracks"));
    expect(screen.getByRole("option", { name: /Warmup/ })).toBeInTheDocument();
    expect(await screen.findByText("Night Bus")).toBeInTheDocument();
  });

  it("does not show an empty playlist control while the list is loading", async () => {
    // The playlists call is left hanging, so the loading state is the state
    // under test rather than a frame the assertions have to catch.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/playlists")) return new Promise(() => {});
        return new Response(JSON.stringify({ available, connections: [connection] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    render(<SourcePicker accountToken="t" onAdd={() => {}} />);

    // A select with no options looks usable and is not.
    expect(await screen.findByText(/Loading your playlists/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Choose a playlist" })).toBeNull();
  });

  it("sends the search to the server rather than filtering locally", async () => {
    const calls = connected();
    render(<SourcePicker accountToken="t" onAdd={() => {}} />);
    await screen.findByText("Night Bus");

    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search this playlist" }),
      "night",
    );
    await waitFor(() =>
      expect(calls.some((url) => url.includes("tracks?q=night"))).toBe(true),
    );
  });

  it("hands the picked songs up with the service they came from", async () => {
    const onAdd = vi.fn();
    connected();
    render(<SourcePicker accountToken="t" onAdd={onAdd} />);

    await userEvent.click(await screen.findByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /Add 1 song/ }));

    expect(onAdd).toHaveBeenCalledWith(
      [expect.objectContaining({ providerTrackId: "soundcloud:tracks:111" })],
      "soundcloud",
    );
  });

  it("will not add before anything is picked", async () => {
    connected();
    render(<SourcePicker accountToken="t" onAdd={() => {}} />);
    expect(
      await screen.findByRole("button", { name: "Select songs to add" }),
    ).toBeDisabled();
  });

  it("goes back to offering Connect after disconnecting", async () => {
    const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const disconnected = init?.method === "DELETE";
      if (disconnected) return new Response("{}", { status: 200 });
      const payload = url.includes("/playlists/")
        ? { tracks }
        : url.includes("/playlists")
          ? { playlists }
          : { available, connections: spy.mock.calls.some((c) => c[1]?.method === "DELETE") ? [] : [connection] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", spy);

    render(<SourcePicker accountToken="t" onAdd={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /Disconnect/ }));

    expect(
      await screen.findByRole("button", { name: "Connect SoundCloud" }),
    ).toBeInTheDocument();
  });
});

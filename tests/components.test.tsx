// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dashboard, {
  IdentityGate,
  LibraryPicker,
  NowPlayingDock,
  QueueList,
  facesThatFit,
} from "@/components/Dashboard";
import { previewSeconds } from "@/lib/preview";
import type { PublicSession, SessionTrack } from "@/lib/sessions";

vi.mock("react-qr-code", () => ({
  default: ({ value }: { value: string }) => (
    <svg data-encoded-value={value} />
  ),
}));

const tracks: SessionTrack[] = [
  {
    id: "track-one",
    title: "First Track",
    artist: "Artist A",
    votes: 2,
    position: 0,
    previewUrl: "/api/tracks/track-one/preview",
    artworkUrl: null,
    durationMs: null,
    source: null,
    playedAt: null,
    cooldown: 0,
    voters: [],
  },
  {
    id: "track-two",
    title: "Second Track",
    artist: "Artist B",
    votes: 1,
    position: 1,
    previewUrl: "/api/tracks/track-two/preview",
    artworkUrl: null,
    durationMs: null,
    source: null,
    playedAt: null,
    cooldown: 0,
    voters: [],
  },
];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("identity onboarding", () => {
  it("submits a phone number and self-chosen username", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <IdentityGate
        joiningRoom={false}
        onSave={onSave}
        onLogin={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText(/Phone number/), "+32 470 12 34 56");
    await user.type(screen.getByLabelText(/Username/), "Night Owl");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("+32 470 12 34 56", "Night Owl"),
    );
    // Picking a name gets the headline alone: no explanatory line, and
    // nothing about phone numbers beyond the field itself.
    expect(screen.queryByText(/phone number is/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/username is what/i)).not.toBeInTheDocument();
  });

  it("shows account errors without leaving the form", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error("Phone already registered"));
    render(
      <IdentityGate joiningRoom onSave={onSave} onLogin={vi.fn()} />,
    );

    await user.type(screen.getByLabelText(/Phone number/), "+32470000000");
    await user.type(screen.getByLabelText(/Username/), "Mint Fox");
    await user.click(screen.getByRole("button", { name: /join room/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Phone already registered",
    );
  });

  it("retries a timed-out account creation with the same request", async () => {
    const user = userEvent.setup();
    const accountRequests: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/accounts" && init?.method === "POST") {
          accountRequests.push(String(init.body));
          if (accountRequests.length === 1) {
            throw new Error("The connection timed out.");
          }
          return Response.json({
            account: {
              id: "account-retried",
              pseudonym: "Patient Owl",
              phoneLast4: "0000",
            },
            token: "retried-account-token",
          });
        }
        if (url === "/api/sessions") {
          return Response.json({ activeRoom: null });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<Dashboard />);

    await user.type(await screen.findByLabelText(/Phone number/), "+32470000000");
    await user.type(screen.getByLabelText(/Username/), "Patient Owl");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(accountRequests).toHaveLength(2));
    expect(accountRequests[1]).toBe(accountRequests[0]);
    expect(window.localStorage.getItem("upnext-account-token")).toBe(
      "retried-account-token",
    );
    expect(screen.queryByText("The connection timed out.")).not.toBeInTheDocument();
  });

  it("switches to phone-only login", async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn().mockResolvedValue(undefined);
    render(
      <IdentityGate joiningRoom onSave={vi.fn()} onLogin={onLogin} />,
    );

    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(screen.queryByLabelText(/Username/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/Phone number/), "+32470000000");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() =>
      expect(onLogin).toHaveBeenCalledWith("+32470000000"),
    );
  });

  it("allows one free vote, then logs in before applying the next vote", async () => {
    const user = userEvent.setup();
    const session = (votedTrackIds: string[], totalVotes: number): PublicSession => ({
      id: "ABC123",
      name: "Browser Vote Room",
      djName: "DJ Owl",
      djAvatarUrl: null,
      djTagline: "",
      tipLinks: { cashApp: null, venmo: null },
      venue: "Test Venue",
      createdAt: "2026-08-26T00:00:00.000Z",
      revision: totalVotes,
      totalVotes,
      guestCount: totalVotes > 0 ? 1 : 0,
      votedTrackIds,
      anonymousVoteUsed: votedTrackIds.length > 0,
      nowPlaying: null,
      voters: [],
      tracks: [
        { ...tracks[0], votes: totalVotes > 0 ? 1 : 0 },
        { ...tracks[1], votes: totalVotes > 1 ? 1 : 0 },
      ],
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        if (url === "/api/accounts/login" && init?.method === "POST") {
          expect(headers.get("x-upnext-voter-id")).toBe(
            window.localStorage.getItem("upnext-voter-id"),
          );
          expect(JSON.parse(String(init.body))).toEqual({
            phone: "+32470000000",
          });
          return Response.json({
            account: {
              id: "account-one",
              pseudonym: "Phone Guest",
              phoneLast4: "0000",
            },
            token: "account-token",
          });
        }
        if (url.endsWith("/vote") && init?.method === "POST") {
          const authenticated = headers.has("authorization");
          return Response.json({
            session: authenticated
              ? session(["track-one", "track-two"], 2)
              : session(["track-one"], 1),
            voted: true,
          });
        }
        return Response.json({ session: session([], 0) });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<Dashboard initialSessionId="ABC123" />);

    expect(await screen.findByText("Browser Vote Room")).toBeInTheDocument();
    expect(screen.getByText(/Room ABC123/i)).toBeInTheDocument();
    expect(screen.queryByText("Pick a name.")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("upnext-voter-id")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: /vote for first track, 0 votes/i }),
    );
    expect(await screen.findByText("Vote saved")).toBeInTheDocument();
    expect(window.localStorage.getItem("upnext-anonymous-votes")).toContain(
      "track-one",
    );
    expect(
      screen.getByRole("button", { name: /vote saved for first track/i }),
    ).toBeDisabled();

    await user.click(
      screen.getByRole("button", { name: /vote for second track, 0 votes/i }),
    );
    expect(await screen.findByText("Your first vote is in.")).toBeInTheDocument();
    expect(screen.getByText(/add your phone to vote again/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Log in" }));
    await user.type(screen.getByLabelText(/Phone number/), "+32470000000");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Phone Guest")).toBeInTheDocument();
    expect(window.localStorage.getItem("upnext-account-token")).toBe(
      "account-token",
    );
    expect(window.localStorage.getItem("upnext-account-request-id")).toBeNull();
    const voteCalls = fetchMock.mock.calls.filter(
      ([input, init]) => String(input).endsWith("/vote") && init?.method === "POST",
    );
    expect(voteCalls).toHaveLength(2);
    expect(new Headers(voteCalls[0][1]?.headers).has("authorization")).toBe(false);
    expect(new Headers(voteCalls[1][1]?.headers).get("authorization")).toBe(
      "Bearer account-token",
    );
  });

  it("repairs an invalid voter ID and clears stale local vote state", async () => {
    window.localStorage.setItem("upnext-voter-id", "invalid voter id value");
    window.localStorage.setItem(
      "upnext-anonymous-votes",
      JSON.stringify({ ABC123: "stale-track" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          session: {
            id: "ABC123",
            name: "Authoritative Room",
            djName: "DJ Owl",
            djAvatarUrl: null,
            djTagline: "",
            tipLinks: { cashApp: null, venmo: null },
            venue: "",
            createdAt: "2026-08-26T00:00:00.000Z",
            revision: 0,
            totalVotes: 0,
            guestCount: 0,
            votedTrackIds: [],
            anonymousVoteUsed: false,
            nowPlaying: null,
            voters: [],
            tracks: [{ ...tracks[0], votes: 0 }],
          },
        }),
      ),
    );

    render(<Dashboard initialSessionId="ABC123" />);

    expect(await screen.findByText("Authoritative Room")).toBeInTheDocument();
    expect(screen.getByText("Free vote")).toBeInTheDocument();
    expect(window.localStorage.getItem("upnext-voter-id")).toMatch(
      /^[A-Za-z0-9_-]{16,100}$/,
    );
    expect(window.localStorage.getItem("upnext-voter-id")).not.toBe(
      "invalid voter id value",
    );
    expect(window.localStorage.getItem("upnext-anonymous-votes")).toBe("{}");
  });
});

describe("conditional room polling", () => {
  const room = (revision: number): PublicSession => ({
    id: "ABC123",
    name: "Conditional Room",
    djName: "DJ Owl",
    djAvatarUrl: null,
    djTagline: "",
    tipLinks: { cashApp: null, venmo: null },
    venue: "Test Venue",
    createdAt: "2026-08-26T00:00:00.000Z",
    revision,
    totalVotes: 0,
    guestCount: 0,
    votedTrackIds: [],
    anonymousVoteUsed: false,
    nowPlaying: null,
    voters: [],
    tracks,
  });

  it("keeps the room on screen when the server answers 304", async () => {
    let roomRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("/api/sessions/")) return Response.json({ session: room(0) });
      roomRequests += 1;
      const headers = new Headers(init?.headers);
      if (headers.get("If-None-Match") === '"ABC123-0-viewer"') {
        return new Response(null, { status: 304, headers: { ETag: '"ABC123-0-viewer"' } });
      }
      return Response.json({ session: room(0) }, { headers: { ETag: '"ABC123-0-viewer"' } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Dashboard initialSessionId="ABC123" />);

    expect(await screen.findByText("Conditional Room")).toBeInTheDocument();
    // The poll reschedules every 2s, so wait past one interval for the 304.
    await waitFor(() => expect(roomRequests).toBeGreaterThan(1), { timeout: 5000 });
    expect(screen.getByText("Conditional Room")).toBeInTheDocument();
    expect(screen.getAllByText("First Track").length).toBeGreaterThan(0);
  });

  it("recovers when a 304 arrives before any room payload was held", async () => {
    // A conditional request must never be sent without the representation it
    // claims to hold. If one somehow is, the client has to refetch rather than
    // loop on 304 with an empty screen.
    let roomRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.startsWith("/api/sessions/")) return Response.json({ session: room(0) });
      roomRequests += 1;
      if (roomRequests === 1) {
        return new Response(null, { status: 304, headers: { ETag: '"ABC123-0-viewer"' } });
      }
      return Response.json({ session: room(0) }, { headers: { ETag: '"ABC123-0-viewer"' } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Dashboard initialSessionId="ABC123" />);

    // Recovery costs one poll interval, so allow more than the 1s default.
    expect(
      await screen.findByText("Conditional Room", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(roomRequests).toBeGreaterThan(1);
  });
});

describe("guest link reachability", () => {
  const hostRoom: PublicSession = {
    id: "ABC123",
    name: "Host Room",
    djName: "DJ Owl",
    djAvatarUrl: null,
    djTagline: "",
    tipLinks: { cashApp: null, venmo: null },
    venue: "Test Venue",
    createdAt: "2026-08-26T00:00:00.000Z",
    revision: 0,
    totalVotes: 0,
    guestCount: 0,
    votedTrackIds: [],
    anonymousVoteUsed: false,
    nowPlaying: null,
    voters: [],
    tracks,
  };

  function mountHost(guestBaseUrl: string | null) {
    window.localStorage.setItem("upnext-account-token", "host-token");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/accounts") {
        return Response.json({
          account: { id: "host", pseudonym: "DJ", phoneLast4: "1234" },
        });
      }
      if (url === "/api/sessions") {
        return Response.json({
          activeRoom: { session: hostRoom, hostKey: "host-key" },
          guestBaseUrl,
        });
      }
      return Response.json({ session: hostRoom });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Dashboard />);
  }

  it("refuses to show a QR code for a loopback address", async () => {
    // jsdom serves the page from localhost, so with nothing configured the
    // derived link is one no guest could ever load.
    mountHost(null);

    expect(
      await screen.findByText(/cannot reach any guest/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/APP_PUBLIC_URL/);
    expect(document.querySelector(".qr-frame")).toBeNull();
  });

  it("shows the QR for a LAN address but warns about mobile data", async () => {
    mountHost("http://10.0.0.117:3000");

    expect(await screen.findByText(/same-network link/i)).toBeInTheDocument();
    expect(screen.getByText(/guests on mobile data cannot open it/i)).toBeInTheDocument();
    // Still usable at a venue where everyone joins the house wifi.
    expect(document.querySelector(".qr-frame")).not.toBeNull();
    expect(
      screen.getByLabelText("Guest room link"),
    ).toHaveValue("http://10.0.0.117:3000/?session=ABC123");
  });

  it("says nothing when the configured URL is publicly reachable", async () => {
    mountHost("https://upnext.example.com");

    expect(
      await screen.findByLabelText("Guest room link"),
    ).toHaveValue("https://upnext.example.com/?session=ABC123");
    expect(document.querySelector(".qr-frame")).not.toBeNull();
    expect(screen.queryByText(/cannot reach any guest/i)).toBeNull();
    expect(screen.queryByText(/same-network link/i)).toBeNull();
  });
});

describe("library picker", () => {
  const library = { id: "lib-1", name: "Deep House", description: "", trackCount: 2, createdAt: "" };
  const libraryTracks = [
    {
      id: "lt-1", libraryId: "lib-1", title: "Sunrise", artist: "Kora",
      previewUrl: "/api/library-tracks/lt-1/preview",
      libraryPreviewKey: "previews/curator/sunrise.mp3",
      contributedBy: null, createdAt: "",
    },
    {
      id: "lt-2", libraryId: "lib-1", title: "Moonfall", artist: "Vega",
      previewUrl: null, libraryPreviewKey: null,
      contributedBy: null, createdAt: "",
    },
  ];

  function mockApi(libs = [library], tracks = libraryTracks) {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "/api/libraries") return Response.json({ libraries: libs });
      if (url.includes("/tracks")) return Response.json({ tracks });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    return calls;
  }

  it("stays out of the way when no libraries exist", async () => {
    mockApi([]);
    const { container } = render(
      <LibraryPicker accountToken="t" onAdd={() => {}} />,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.querySelector(".library-picker")).toBeNull();
  });

  it("hands back the preview key so the song is never re-uploaded", async () => {
    const user = userEvent.setup();
    mockApi();
    const onAdd = vi.fn();
    render(<LibraryPicker accountToken="t" onAdd={onAdd} />);

    await user.click(await screen.findByRole("checkbox", { name: /sunrise/i }));
    await user.click(screen.getByRole("button", { name: /add 1 song/i }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    const picked = onAdd.mock.calls[0][0];
    expect(picked).toHaveLength(1);
    // Without this the DJ would upload a file they never chose.
    expect(picked[0].libraryPreviewKey).toBe("previews/curator/sunrise.mp3");
  });

  it("adds the entire in-house library without individual picks", async () => {
    mockApi();
    const onAdd = vi.fn();
    render(<LibraryPicker accountToken="t" onAdd={onAdd} />);

    await screen.findByRole("checkbox", { name: /sunrise/i });
    await userEvent.click(
      screen.getByRole("button", { name: "Add entire library" }),
    );

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(libraryTracks));
  });

  it("marks a catalogue entry that has no preview", async () => {
    mockApi();
    render(<LibraryPicker accountToken="t" onAdd={() => {}} />);
    expect(await screen.findByText(/no audio/i)).toBeInTheDocument();
  });

  it("sends the search to the server rather than filtering locally", async () => {
    const user = userEvent.setup();
    const calls = mockApi();
    render(<LibraryPicker accountToken="t" onAdd={() => {}} />);
    await screen.findByRole("checkbox", { name: /sunrise/i });

    await user.type(screen.getByLabelText(/search this library/i), "moon");

    // Server-side search is what keeps a large catalogue usable.
    await waitFor(
      () => expect(calls.some((c) => c.includes("q=moon"))).toBe(true),
      { timeout: 3000 },
    );
  });
});

/** Stands in for the element a row builds with `new Audio()`. */
class MockAudio {
  static instances: MockAudio[] = [];
  src = "";
  preload = "";
  currentTime = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onpause: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn();
  constructor() {
    MockAudio.instances.push(this);
  }
}

function stubRowAudio() {
  MockAudio.instances = [];
  vi.stubGlobal("Audio", MockAudio);
}

describe("the DJ's pre-listen", () => {
  beforeEach(stubRowAudio);

  it("plays the resolved URL, one row at a time, and ignores stale media events", async () => {
    const user = userEvent.setup();
    const onAudition = vi.fn(async (track: SessionTrack) => `https://signed.example/${track.id}`);
    const { unmount } = render(<QueueList tracks={tracks} onAudition={onAudition} />);
    const firstButton = screen.getByRole("button", { name: /^pre-listen to first track$/i });
    const secondButton = screen.getByRole("button", { name: /^pre-listen to second track$/i });

    await user.click(firstButton);
    await waitFor(() => expect(firstButton).toHaveAttribute("aria-pressed", "true"));
    const firstAudio = MockAudio.instances[0];
    expect(firstAudio.src).toBe("https://signed.example/track-one");
    expect(onAudition).toHaveBeenCalledWith(tracks[0]);
    const staleError = firstAudio.onerror;

    await user.click(secondButton);
    await waitFor(() => expect(secondButton).toHaveAttribute("aria-pressed", "true"));
    expect(firstAudio.pause).toHaveBeenCalled();
    staleError?.();
    expect(secondButton).toHaveAttribute("aria-pressed", "true");

    const secondAudio = MockAudio.instances[1];
    unmount();
    expect(secondAudio.pause).toHaveBeenCalled();
    expect(secondAudio.removeAttribute).toHaveBeenCalledWith("src");
  });

  it("stops the row at the end of the preview window, with the file left whole", async () => {
    const user = userEvent.setup();
    render(
      <QueueList
        tracks={tracks}
        onAudition={async (track) => `https://signed.example/${track.id}`}
      />,
    );
    const button = screen.getByRole("button", { name: /^pre-listen to first track$/i });
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));

    const audio = MockAudio.instances[0];
    audio.currentTime = previewSeconds - 1;
    audio.ontimeupdate?.();
    expect(audio.pause).not.toHaveBeenCalled();

    audio.currentTime = previewSeconds;
    audio.ontimeupdate?.();
    expect(audio.pause).toHaveBeenCalled();
    // Nothing was cut: the element still holds the whole signed URL, and the
    // row is back to Play once the element reports it paused.
    expect(audio.src).toBe("https://signed.example/track-one");
    audio.onpause?.();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^pre-listen to first track$/i }),
      ).toHaveAttribute("aria-pressed", "false"),
    );
  });

  it("drops the Stop state when the URL cannot be resolved", async () => {
    const user = userEvent.setup();
    render(
      <QueueList tracks={tracks} onAudition={async () => { throw new Error("nope"); }} />,
    );
    await user.click(screen.getByRole("button", { name: /^pre-listen to first track$/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^pre-listen to first track$/i })).toHaveAttribute(
        "aria-pressed",
        "false",
      ),
    );
    expect(MockAudio.instances[0].play).not.toHaveBeenCalled();
  });
});

describe("credit on an imported row", () => {
  const imported: SessionTrack[] = [
    {
      ...tracks[0],
      source: {
        provider: "soundcloud",
        permalinkUrl: "https://soundcloud.com/djowl/night-bus",
        uploaderName: "DJ Owl",
      },
    },
  ];

  it("names the uploader and the service, and links back to the track", () => {
    // Required by the provider's terms wherever its content is shown, so it
    // is a test rather than a styling detail.
    render(<QueueList tracks={imported} />);

    const credit = screen.getByRole("link", { name: /DJ Owl on SoundCloud/ });
    expect(credit).toHaveAttribute(
      "href",
      "https://soundcloud.com/djowl/night-bus",
    );
    expect(credit).toHaveAttribute("target", "_blank");
    expect(credit).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("leaves an uploaded row uncredited", () => {
    render(<QueueList tracks={tracks} />);
    expect(screen.queryByRole("link", { name: /on SoundCloud/ })).toBeNull();
  });

  it("still offers a pre-listen on an imported row", async () => {
    const onAudition = vi.fn(async () => "https://cf-preview.sndcdn.com/p.mp3");
    render(<QueueList tracks={imported} onAudition={onAudition} />);

    await userEvent.click(
      screen.getByRole("button", { name: /Pre-listen to First Track/ }),
    );
    expect(onAudition).toHaveBeenCalled();
  });
});

describe("queue interactions", () => {
  it("exposes vote count and selected state accessibly", async () => {
    const user = userEvent.setup();
    const onVote = vi.fn();
    render(
      <QueueList
        tracks={tracks}
        interactive
        votedTrackIds={new Set(["track-one"])}
        onVote={onVote}
      />,
    );

    const selectedVote = screen.getByRole("button", {
      name: /remove vote from first track, 2 votes/i,
    });
    expect(selectedVote).toHaveAttribute("aria-pressed", "true");
    await user.click(selectedVote);
    expect(onVote).toHaveBeenCalledWith("track-one");

    expect(
      screen.getByRole("button", {
        name: /vote for second track, 1 vote/i,
      }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the tip action on saved picks after their active vote is spent", async () => {
    const user = userEvent.setup();
    const onTip = vi.fn();
    render(
      <QueueList
        tracks={tracks}
        interactive
        votedTrackIds={new Set()}
        tipEligibleTrackIds={new Set(["track-one"])}
        onVote={vi.fn()}
        onTip={onTip}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Open tip options for First Track by Artist A, row 1",
    });
    expect(
      screen.queryByRole("button", {
        name: "Open tip options for Second Track by Artist B, row 2",
      }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Tip for this pick")).toHaveLength(1);
    await user.click(button);
    expect(onTip).toHaveBeenCalledWith(tracks[0]);
  });
});

describe("connected sources in the setup form", () => {
  function setupBooth(connections: unknown[]) {
    window.localStorage.setItem("upnext-account-token", "host-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/accounts") {
          return Response.json({
            account: { id: "host", pseudonym: "DJ Owl", phoneLast4: "1234" },
          });
        }
        if (url === "/api/libraries") return Response.json({ libraries: [] });
        if (url === "/api/connections") {
          return Response.json({
            available: [
              { provider: "soundcloud", label: "SoundCloud", unavailableReason: null },
            ],
            connections,
          });
        }
        if (url.includes("/playlists")) return Response.json({ playlists: [] });
        return Response.json({ activeRoom: null, guestBaseUrl: null });
      }),
    );
    render(<Dashboard />);
  }

  it("offers to connect a service where the DJ adds the music", async () => {
    setupBooth([]);
    expect(
      await screen.findByRole(
        "button",
        { name: "Connect SoundCloud" },
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
  });

  it("names the connected account instead of asking again", async () => {
    setupBooth([
      { provider: "soundcloud", label: "SoundCloud", displayName: "DJ Owl" },
    ]);
    expect(
      await screen.findByText(/SoundCloud · DJ Owl/, {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect SoundCloud" }),
    ).toBeNull();
  });
});

describe("tip handles in the setup form", () => {
  async function typeCashtag(value: string) {
    const user = userEvent.setup();
    window.localStorage.setItem("upnext-account-token", "host-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/accounts") {
          return Response.json({
            account: { id: "host", pseudonym: "DJ Owl", phoneLast4: "1234" },
          });
        }
        if (url === "/api/libraries") return Response.json({ libraries: [] });
        return Response.json({ activeRoom: null, guestBaseUrl: null });
      }),
    );
    render(<Dashboard />);
    const field = await screen.findByLabelText(/cash app/i, {}, { timeout: 3000 });
    await user.type(field, value);
    return { field, user };
  }

  it("says what is wrong under the field, before a single track uploads", async () => {
    const { field } = await typeCashtag("1owl");

    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByText(/cashtag that starts with a letter/i),
    ).toBeInTheDocument();
    // Nothing to launch into: the room would refuse this handle, so the DJ is
    // not sent through an upload to be told so.
    expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();
    expect(screen.queryByText("Crowd tips enabled")).not.toBeInTheDocument();
  });

  it("clears once the handle is one the room would take", async () => {
    const { field, user } = await typeCashtag("1owl");
    await user.clear(field);
    await user.type(field, "$DJOwl");

    expect(field).toHaveAttribute("aria-invalid", "false");
    expect(
      screen.queryByText(/cashtag that starts with a letter/i),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Crowd tips enabled")).toBeInTheDocument();
  });

  it("keeps payment details ahead of the track state, under one start action", async () => {
    const { field } = await typeCashtag("$DJOwl");
    const uploader = screen.getByText("Choose files").closest("label");
    const trackState = document.querySelector(".empty-tracks");

    expect(uploader).not.toBeNull();
    expect(trackState).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Restore demo" })).toBeNull();
    expect(
      uploader?.compareDocumentPosition(field) ?? 0,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(field.compareDocumentPosition(trackState as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // One Start, and it lives in the launch panel: the aside is sticky beside
    // the form on desktop and a bar pinned to the bottom below 900px, so the
    // action is always in reach without a second copy inside the form.
    const starts = screen.getAllByRole("button", { name: "Start session" });
    expect(starts).toHaveLength(1);
    expect(starts[0].closest(".launch-panel")).not.toBeNull();
  });
});

describe("external tips", () => {
  const room: PublicSession = {
    id: "ABC123",
    name: "Tip Room",
    djName: "DJ Owl",
    djAvatarUrl: null,
    djTagline: "",
    tipLinks: {
      cashApp: "https://cash.app/$DJOwl",
      venmo: "https://account.venmo.com/u/dj-owl",
    },
    venue: "",
    createdAt: new Date().toISOString(),
    revision: 1,
    totalVotes: 1,
    guestCount: 1,
    votedTrackIds: ["track-one"],
    anonymousVoteUsed: true,
    nowPlaying: null,
    voters: [],
    tracks: [{ ...tracks[0], votes: 1 }, tracks[1]],
  };

  it("keeps the room standing when the payload predates tip links", async () => {
    // Mid-deploy: this bundle polls an instance that has never heard of
    // tipLinks. A ballot with no tip buttons beats a blank page.
    const { tipLinks, ...olderPayload } = room;
    void tipLinks;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ session: olderPayload })),
    );
    render(<Dashboard initialSessionId="ABC123" />);

    await screen.findByRole("heading", { name: "Make your picks" }, { timeout: 3000 });
    expect(screen.getAllByText("First Track").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: /^open tip options/i }),
    ).not.toBeInTheDocument();
  });

  it("opens provider links with a copyable reference and no play promise", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ session: room })),
    );
    const view = render(<Dashboard initialSessionId="ABC123" />);

    const trigger = await screen.findByRole("button", {
      name: "Open tip options for First Track by Artist A, row 1",
    });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", {
      name: "Tip for this pick",
    });
    expect(within(dialog).getByText("First Track")).toBeInTheDocument();
    expect(within(dialog).getByText(/does not change the queue/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/does not verify who owns/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/guarantee/i)).toBeInTheDocument();
    const cashAppQr = within(dialog).getByRole("img", {
      name: "Cash App QR code for DJ Owl",
    });
    expect(cashAppQr.querySelector("svg")).toHaveAttribute(
      "data-encoded-value",
      "https://cash.app/$DJOwl",
    );
    expect(within(dialog).getByRole("link", { name: /open cash app/i })).toHaveAttribute(
      "href",
      "https://cash.app/$DJOwl",
    );
    expect(within(dialog).getByRole("link", { name: /open venmo/i })).toHaveAttribute(
      "href",
      "https://account.venmo.com/u/dj-owl",
    );

    const close = within(dialog).getByRole("button", { name: "Close tip options" });
    await waitFor(() => expect(close).toHaveFocus());
    await user.tab({ shift: true });
    expect(within(dialog).getByRole("link", { name: /open venmo/i })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Copy payment note" }));
    expect(writeText).toHaveBeenCalledWith(
      "UP/NEXT ABC123: First Track by Artist A",
    );
    expect(await within(dialog).findByText("Reference copied.")).toBeInTheDocument();

    writeText.mockRejectedValueOnce(new Error("denied"));
    await user.click(within(dialog).getByRole("button", { name: "Copy payment note" }));
    expect(await within(dialog).findByText("Copy the reference manually.")).toBeInTheDocument();

    // Polling and playback update the parent while the sheet is open. That
    // must not replace the original trigger remembered for focus restoration.
    view.rerender(<Dashboard initialSessionId="ABC123" />);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("does not show a Cash App QR when the DJ only provides Venmo", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          session: {
            ...room,
            tipLinks: { cashApp: null, venmo: room.tipLinks.venmo },
          },
        }),
      ),
    );
    render(<Dashboard initialSessionId="ABC123" />);

    await user.click(await screen.findByRole("button", {
      name: "Open tip options for First Track by Artist A, row 1",
    }));
    const dialog = screen.getByRole("dialog", { name: "Tip for this pick" });

    expect(within(dialog).queryByRole("img", { name: /Cash App QR/i })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /open venmo/i })).toBeInTheDocument();
  });

  it("sends room-scoped handles at launch and remembers them on this device", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("upnext-account-token", "host-token");
    let creationBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/accounts") {
          return Response.json({
            account: { id: "host", pseudonym: "DJ Owl", phoneLast4: "1234" },
          });
        }
        if (url === "/api/libraries") {
          return Response.json({
            libraries: [
              {
                id: "lib-1",
                name: "House picks",
                description: "",
                trackCount: 1,
                createdAt: "",
              },
            ],
          });
        }
        if (url.startsWith("/api/libraries/lib-1/tracks")) {
          return Response.json({
            tracks: [
              {
                id: "lt-1",
                libraryId: "lib-1",
                title: "Sunrise",
                artist: "Kora",
                previewUrl: "/api/library-tracks/lt-1/preview",
                libraryPreviewKey: "previews/curator/sunrise.mp3",
                contributedBy: null,
                createdAt: "",
              },
            ],
          });
        }
        if (url === "/api/sessions" && init?.method === "POST") {
          creationBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return Response.json(
            { session: room, hostKey: "host-key", guestBaseUrl: null },
            { status: 201 },
          );
        }
        if (url === "/api/sessions") {
          return Response.json({ activeRoom: null, guestBaseUrl: null });
        }
        if (url === "/api/sessions/ABC123") {
          return Response.json({ session: room });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<Dashboard />);

    await user.click(
      await screen.findByRole("button", { name: "Add entire library" }),
    );
    const keepOpen = screen.getByRole("checkbox", {
      name: /keep session live until i end it/i,
    });
    expect(keepOpen).not.toBeChecked();
    await user.click(keepOpen);
    const cashApp = await screen.findByLabelText(/Cash App/i);
    const venmo = screen.getByLabelText(/Venmo/i);
    await user.type(cashApp, "$DJOwl");
    await user.type(venmo, "@dj-owl");
    await user.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(creationBody).not.toBeNull());
    expect(creationBody).toMatchObject({
      cashAppHandle: "$DJOwl",
      venmoHandle: "@dj-owl",
      keepOpen: true,
    });
    expect(JSON.parse(window.localStorage.getItem("upnext-tip-handles") ?? "null")).toEqual({
      cashAppHandle: "$DJOwl",
      venmoHandle: "@dj-owl",
    });
  });
});

describe("review fixes", () => {
  it("queues a catalogue song once even when it is added twice", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("upnext-account-token", "host-token");
    const library = { id: "lib-1", name: "Deep House", description: "", trackCount: 1, createdAt: "" };
    const libraryTracks = [
      {
        id: "lt-1", libraryId: "lib-1", title: "Sunrise", artist: "Kora",
        previewUrl: "/api/library-tracks/lt-1/preview",
        libraryPreviewKey: "previews/curator/sunrise.mp3",
        contributedBy: null, createdAt: "",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/accounts") {
          return Response.json({
            account: { id: "host", pseudonym: "DJ", phoneLast4: "1234" },
          });
        }
        if (url === "/api/sessions") {
          return Response.json({ activeRoom: null, guestBaseUrl: null });
        }
        if (url === "/api/libraries") return Response.json({ libraries: [library] });
        if (url.includes("/tracks")) return Response.json({ tracks: libraryTracks });
        return Response.json({});
      }),
    );
    render(<Dashboard />);

    for (let round = 0; round < 2; round += 1) {
      await user.click(await screen.findByRole("checkbox", { name: /sunrise/i }));
      await user.click(screen.getByRole("button", { name: /add 1 song/i }));
    }

    expect(screen.getAllByRole("button", { name: /remove sunrise/i })).toHaveLength(1);
  });

  it("says why the profile is not loading instead of spinning silently", async () => {
    window.localStorage.setItem("upnext-account-token", "host-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>502</html>", { status: 502 })),
    );
    render(<Dashboard />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/retrying/i);
    expect(screen.getByRole("button", { name: /try again now/i })).toBeInTheDocument();
  });
});

describe("starting a room from a playlist", () => {
  function mountWithPlaylist(playlistResponse: () => Response) {
    window.localStorage.setItem("upnext-account-token", "host-token");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/accounts") {
        return Response.json({
          account: { id: "host", pseudonym: "DJ", phoneLast4: "1234" },
        });
      }
      if (url === "/api/sessions") {
        if (init?.method === "POST") throw new Error("no room should be created");
        return Response.json({ activeRoom: null, guestBaseUrl: null });
      }
      if (url === "/api/playlists/pl-1") return playlistResponse();
      return Response.json({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Dashboard initialPlaylistId="pl-1" />);
    return fetchMock;
  }

  it("seeds the room name and draft from the playlist without creating a room", async () => {
    const fetchMock = mountWithPlaylist(() =>
      Response.json({
        playlist: { id: "pl-1", name: "Warm Up Set" },
        tracks: [
          {
            id: "lt-1",
            libraryId: "lib",
            title: "Essence",
            artist: "Wizkid",
            previewUrl: "/api/library-tracks/lt-1/preview",
            libraryPreviewKey: "previews/essence.mp3",
            contributedBy: null,
            createdAt: "2026-08-26T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(
      await screen.findByDisplayValue("Warm Up Set", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Essence")).toBeInTheDocument();
    expect(screen.queryByText("NUEVAYoL")).not.toBeInTheDocument();
    const roomCreations = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input) === "/api/sessions" && init?.method === "POST",
    );
    expect(roomCreations).toHaveLength(0);
  });

  it("keeps an empty draft and explains when the playlist is not the DJ's", async () => {
    mountWithPlaylist(() =>
      Response.json({ error: "That playlist could not be found." }, { status: 404 }),
    );
    expect(
      await screen.findByText("That playlist could not be found.", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("Friday After Dark")).toBeInTheDocument();
    expect(screen.getByText("Your set is empty")).toBeInTheDocument();
  });
});

describe("the playlist seed parameter", () => {
  it("is dropped from the address once consumed, so a reload keeps the DJ's edits", async () => {
    window.history.replaceState({}, "", "/?playlist=pl-1");
    window.localStorage.setItem("upnext-account-token", "host-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/accounts") {
          return Response.json({
            account: { id: "host", pseudonym: "DJ", phoneLast4: "1234" },
          });
        }
        if (url === "/api/sessions") {
          return Response.json({ activeRoom: null, guestBaseUrl: null });
        }
        if (url === "/api/playlists/pl-1") {
          return Response.json({
            playlist: { id: "pl-1", name: "Warm Up Set" },
            tracks: [
              {
                id: "lt-1", libraryId: "lib", title: "Essence", artist: "Wizkid",
                previewUrl: "/api/library-tracks/lt-1/preview",
                libraryPreviewKey: "previews/essence.mp3",
                contributedBy: null, createdAt: "",
              },
            ],
          });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      }),
    );
    render(<Dashboard initialPlaylistId="pl-1" />);

    await screen.findByDisplayValue("Warm Up Set", {}, { timeout: 3000 });
    expect(window.location.search).toBe("");
  });
});

describe("now playing", () => {
  const room: PublicSession = {
    id: "ABC123",
    name: "Room",
    djName: "DJ Owl",
    djAvatarUrl: null,
    djTagline: "",
    tipLinks: { cashApp: null, venmo: null },
    venue: "",
    createdAt: "2026-08-26T00:00:00.000Z",
    revision: 3,
    totalVotes: 0,
    guestCount: 0,
    votedTrackIds: [],
    anonymousVoteUsed: false,
    voters: [],
    nowPlaying: {
      trackId: "track-one",
      title: "First Track",
      artist: "Artist A",
      previewUrl: "/api/tracks/track-one/preview",
      artworkUrl: null,
      durationMs: null,
      source: null,
      startedAt: new Date(Date.now() - 20_000).toISOString(),
    },
    tracks: [
      { ...tracks[0], playedAt: "2026-08-26T00:00:00.000Z", cooldown: 2 },
      tracks[1],
    ],
  };

  it("docks the DJ's song under the ballot and takes the played track off the ballot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ session: room })),
    );
    render(<Dashboard initialSessionId="ABC123" />);

    const dock = await screen.findByRole("region", { name: "Now playing" }, { timeout: 3000 });
    expect(within(dock).getByText("First Track")).toBeInTheDocument();
    expect(within(dock).getByRole("button", { name: "Listen along" })).toBeEnabled();
    // The crowd pick is the next song off cooldown; one still cooling cannot be
    // voted for and says how long it has left.
    expect(screen.getByText(/Second Track is ranked first/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /vote for first track/i })).toBeDisabled();
    expect(screen.getByText(/cooldown: 2 more songs/)).toBeInTheDocument();
  });

  /**
   * Opens the booth on `room` with nothing playing and answers the next
   * /now-playing call with `reply`. Returns the calls for assertions.
   */
  function openBooth(reply: { session: PublicSession; stale?: boolean }) {
    window.localStorage.setItem("upnext-account-token", "host-token");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === "/api/accounts") {
          return Response.json({ account: { id: "host", pseudonym: "DJ", phoneLast4: "1234" } });
        }
        if (url === "/api/sessions") {
          return Response.json({
            activeRoom: { session: { ...room, nowPlaying: null }, hostKey: "host-key" },
            guestBaseUrl: "https://upnext.example",
          });
        }
        if (url.endsWith("/now-playing")) return Response.json(reply);
        return Response.json({ session: { ...room, nowPlaying: null } });
      }),
    );
    render(<Dashboard />);
    return calls;
  }

  const onTrackTwo: PublicSession = {
    ...room,
    revision: 4,
    nowPlaying: { ...room.nowPlaying!, trackId: "track-two", title: "Second Track", artist: "Artist B" },
  };

  it("lets the DJ put the crowd pick on and adopts the returned room", async () => {
    const user = userEvent.setup();
    const calls = openBooth({ session: onTrackTwo });

    const play = await screen.findByRole(
      "button",
      { name: /play crowd pick: second track/i },
      { timeout: 3000 },
    );
    await user.click(play);

    await screen.findByText("Second Track", { selector: ".now-playing-copy strong" });
    const change = calls.find((call) => call.url.endsWith("/now-playing"));
    expect(change?.init?.method).toBe("POST");
    expect((change?.init?.headers as Record<string, string>)["x-upnext-host-key"]).toBe("host-key");
    expect(JSON.parse(String(change?.init?.body))).toEqual({ trackId: "next" });
  });

  it("lets the DJ put any row on, a cooling one included, naming what it saw playing", async () => {
    const user = userEvent.setup();
    // First Track is on cooldown in this room: votes are refused, the DJ is not.
    const calls = openBooth({
      session: {
        ...room,
        revision: 4,
        nowPlaying: { ...room.nowPlaying!, trackId: "track-one", title: "First Track", artist: "Artist A" },
      },
    });

    const replay = await screen.findByRole(
      "button",
      { name: "Replay First Track (on cooldown)" },
      { timeout: 3000 },
    );
    expect(replay).toHaveTextContent("Replay");
    // The crowd pick and the row's own Play are different controls.
    expect(screen.getByRole("button", { name: /play crowd pick: second track/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play Second Track" })).toHaveTextContent("Play");
    await user.click(replay);

    await screen.findByText("First Track", { selector: ".now-playing-copy strong" });
    const change = calls.find((call) => call.url.endsWith("/now-playing"));
    expect(change?.init?.method).toBe("POST");
    // Nothing was on when the DJ tapped, and the request says so.
    expect(JSON.parse(String(change?.init?.body))).toEqual({ trackId: "track-one", fromTrackId: null });

    // The same control now says On now, still there under the DJ's focus,
    // and the row is neither dimmed nor labelled as cooling.
    const onNow = screen.getByRole("button", { name: "First Track is on now" });
    expect(onNow).toHaveTextContent("On now");
    expect(onNow).toHaveAttribute("aria-disabled", "true");
    expect(onNow).toHaveAttribute("aria-current", "true");
    expect(onNow.closest("li")).toHaveClass("is-on-now");
    expect(onNow.closest("li")).not.toHaveClass("is-played");
    expect(onNow.closest("li")).not.toHaveTextContent(/cooldown/);
    expect(screen.queryByRole("button", { name: /^(re)?play first track/i })).not.toBeInTheDocument();
  });

  it("tells the DJ when the room moved on before the tap landed", async () => {
    const user = userEvent.setup();
    openBooth({ session: onTrackTwo, stale: true });

    const play = await screen.findByRole("button", { name: "Play Second Track" }, { timeout: 3000 });
    await user.click(play);

    // The returned room is adopted, and the stale reply is not passed off as success.
    await screen.findByText("Second Track", { selector: ".now-playing-copy strong" });
    expect(screen.getByRole("alert")).toHaveTextContent(/moved on before that tap landed/);
  });
});

describe("the listen-along dock", () => {
  const song = (trackId: string, title: string, secondsAgo = 20) => ({
    trackId,
    title,
    artist: "Artist",
    previewUrl: `/api/tracks/${trackId}/preview`,
    artworkUrl: null,
    durationMs: null,
    source: null,
    startedAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
  });

  function stubMedia() {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    const pause = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    return { play, pause };
  }

  it("starts playback inside the first tap, not in a later effect", async () => {
    const { play } = stubMedia();
    render(<NowPlayingDock nowPlaying={song("t1", "Opener")} />);

    // fireEvent runs the handler synchronously; a play() that only happened in
    // an effect would still be called here, so also check it saw the src the
    // handler set, which the effect path would only set afterwards.
    const button = screen.getByRole("button", { name: "Listen along" });
    const audio = document.querySelector("audio");
    if (!audio) throw new Error("no audio element");
    fireEvent.click(button);

    expect(play).toHaveBeenCalledTimes(1);
    expect(audio.src).toContain("/api/tracks/t1/preview");
  });

  it("stays unlocked across a song being taken off, so the next one follows without a tap", async () => {
    const { play } = stubMedia();
    const { rerender } = render(<NowPlayingDock nowPlaying={song("t1", "Opener")} />);
    const dock = screen.getByRole("region", { name: "Now playing" });
    fireEvent.click(within(dock).getByRole("button", { name: "Listen along" }));
    expect(play).toHaveBeenCalledTimes(1);

    rerender(<NowPlayingDock nowPlaying={null} />);
    expect(dock).not.toBeVisible();

    rerender(<NowPlayingDock nowPlaying={song("t2", "Banger")} />);
    expect(dock).toBeVisible();
    expect(within(dock).getByText("Banger")).toBeInTheDocument();
    // No second tap needed.
    expect(play).toHaveBeenCalledTimes(2);
    expect(document.querySelector("audio")?.src).toContain("/api/tracks/t2/preview");
  });

  it("moves the waveform only once this phone is actually playing", () => {
    const { play } = stubMedia();
    render(<NowPlayingDock nowPlaying={song("t1", "Opener")} />);
    const dock = screen.getByRole("region", { name: "Now playing" });
    const waveform = dock.querySelector(".waveform");
    if (!waveform) throw new Error("no waveform");

    // Nothing has been tapped, so no sound is coming out of this phone yet.
    expect(waveform.classList.contains("is-playing")).toBe(false);

    fireEvent.click(within(dock).getByRole("button", { name: "Listen along" }));
    expect(play).toHaveBeenCalledTimes(1);
    const audio = document.querySelector("audio");
    if (!audio) throw new Error("no audio element");
    fireEvent.play(audio);

    expect(waveform.classList.contains("is-playing")).toBe(true);

    fireEvent.pause(audio);
    expect(waveform.classList.contains("is-playing")).toBe(false);
  });

  it("does not play a song the room has already finished", () => {
    const { pause } = stubMedia();
    // The DJ put a three-minute song on ten minutes ago.
    render(<NowPlayingDock nowPlaying={song("t1", "Opener", 600)} />);
    const audio = document.querySelector("audio");
    if (!audio) throw new Error("no audio element");
    Object.defineProperty(audio, "duration", { configurable: true, value: 180 });

    fireEvent.click(screen.getByRole("button", { name: "Listen along" }));
    fireEvent(audio, new Event("loadedmetadata"));

    expect(pause).toHaveBeenCalled();
    expect(screen.getByText(/this one's finished/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Listen along" })).toBeDisabled();
  });

  it("picks the song up where the room is after a pre-listen, not where it was left", () => {
    const { play } = stubMedia();
    // The DJ put this on twenty seconds ago (song() default).
    render(<NowPlayingDock nowPlaying={song("t1", "Opener")} />);
    const audio = document.querySelector("audio");
    if (!audio) throw new Error("no audio element");
    Object.defineProperty(audio, "duration", { configurable: true, value: 180 });

    fireEvent.click(screen.getByRole("button", { name: "Listen along" }));
    fireEvent.play(audio);
    // Pre-listening to a row pauses this element (claimAudio), and it is left
    // sitting five seconds in while the room is twenty seconds along.
    fireEvent.pause(audio);
    Object.defineProperty(audio, "currentTime", {
      configurable: true,
      writable: true,
      value: 5,
    });

    fireEvent.click(screen.getByRole("button", { name: "Listen along" }));
    expect(audio.currentTime).toBeGreaterThan(15);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("says a song is finished rather than resuming one the room has run out of", () => {
    const { pause } = stubMedia();
    // A three-minute song the DJ put on ten minutes ago.
    render(<NowPlayingDock nowPlaying={song("t1", "Opener", 600)} />);
    const audio = document.querySelector("audio");
    if (!audio) throw new Error("no audio element");

    fireEvent.click(screen.getByRole("button", { name: "Listen along" }));
    fireEvent.play(audio);
    fireEvent.pause(audio);
    Object.defineProperty(audio, "duration", { configurable: true, value: 180 });

    fireEvent.click(screen.getByRole("button", { name: "Listen along" }));
    expect(pause).toHaveBeenCalled();
    expect(screen.getByText(/this one's finished/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Listen along" })).toBeDisabled();
  });

  it("offers nothing to tap on a row whose audio cannot be resolved", () => {
    // No onAudition: the DJ's own crowd preview of a room not yet started.
    render(<QueueList tracks={tracks} />);
    expect(screen.queryByRole("button", { name: /play/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pre-listen/i })).not.toBeInTheDocument();
    expect(document.querySelector(".preview-play")).toBeNull();
  });
});

describe("the crowd's pre-listen", () => {
  const room: PublicSession = {
    id: "ABC123",
    name: "Room",
    djName: "DJ Owl",
    djAvatarUrl: null,
    djTagline: "",
    tipLinks: { cashApp: null, venmo: null },
    venue: "",
    createdAt: new Date().toISOString(),
    revision: 1,
    totalVotes: 3,
    guestCount: 2,
    votedTrackIds: [],
    anonymousVoteUsed: false,
    nowPlaying: null,
    voters: [],
    tracks,
  };

  beforeEach(stubRowAudio);

  it("gives a guest thirty seconds of a ballot row, and asks for it with no key", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/preview")) {
          expect(init?.headers).toBeUndefined();
          return Response.json({ url: "https://signed.example/track-one" });
        }
        return Response.json({ session: room });
      }),
    );

    render(<Dashboard initialSessionId="ABC123" />);
    const button = await screen.findByRole(
      "button",
      { name: /^pre-listen to first track$/i },
      { timeout: 3000 },
    );
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));

    // The room link is the whole credential: no host key goes out with this.
    expect(calls).toContain("/api/tracks/track-one/preview?as=json");
    const audio = MockAudio.instances[0];
    expect(audio.src).toBe("https://signed.example/track-one");

    audio.currentTime = previewSeconds - 1;
    audio.ontimeupdate?.();
    expect(audio.pause).not.toHaveBeenCalled();

    audio.currentTime = previewSeconds;
    audio.ontimeupdate?.();
    expect(audio.pause).toHaveBeenCalled();
    audio.onpause?.();
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "false"));
  });
});

describe("handing the room back after a pre-listen", () => {
  const roomWithSongOn: PublicSession = {
    id: "ABC123",
    name: "Room",
    djName: "DJ Owl",
    djAvatarUrl: null,
    djTagline: "",
    tipLinks: { cashApp: null, venmo: null },
    venue: "",
    createdAt: new Date().toISOString(),
    revision: 2,
    totalVotes: 3,
    guestCount: 2,
    votedTrackIds: [],
    anonymousVoteUsed: false,
    nowPlaying: {
      trackId: "track-two",
      title: "Second Track",
      artist: "Artist B",
      previewUrl: "/api/tracks/track-two/preview",
      artworkUrl: null,
      durationMs: null,
      source: null,
      startedAt: new Date(Date.now() - 40_000).toISOString(),
    },
    voters: [],
    tracks,
  };

  /** Opens the guest view on a room with a song on, with row audio stubbed. */
  function openRoom() {
    stubRowAudio();
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/preview?as=json")
          ? Response.json({ url: "https://signed.example/track-one" })
          : Response.json({ session: roomWithSongOn }),
      ),
    );
    return { play };
  }

  async function preListenFirstRow(user: ReturnType<typeof userEvent.setup>) {
    const button = await screen.findByRole(
      "button",
      { name: /^pre-listen to first track$/i },
      { timeout: 3000 },
    );
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    const row = MockAudio.instances[0];
    // The window runs out, which is what a guest hears as the preview ending.
    row.currentTime = previewSeconds;
    row.ontimeupdate?.();
    expect(row.pause).toHaveBeenCalled();
    return row;
  }

  it("picks the DJ's song back up, where the room is now", async () => {
    const user = userEvent.setup();
    const { play } = openRoom();
    render(<Dashboard initialSessionId="ABC123" />);

    const dock = await screen.findByRole("region", { name: "Now playing" }, { timeout: 3000 });
    await user.click(within(dock).getByRole("button", { name: "Listen along" }));
    const dockAudio = document.querySelector("audio");
    if (!dockAudio) throw new Error("no dock audio");
    fireEvent.play(dockAudio);
    expect(play).toHaveBeenCalledTimes(1);
    // Left five seconds in while the room is forty seconds into the song.
    Object.defineProperty(dockAudio, "currentTime", {
      configurable: true,
      writable: true,
      value: 5,
    });

    await preListenFirstRow(user);

    // Back to the broadcast without a second tap, and to where the room is
    // rather than where this phone left the song.
    expect(play).toHaveBeenCalledTimes(2);
    expect(dockAudio.currentTime).toBeGreaterThan(35);
  });

  it("leaves a phone that was not listening quiet", async () => {
    const user = userEvent.setup();
    const { play } = openRoom();
    render(<Dashboard initialSessionId="ABC123" />);
    await screen.findByRole("region", { name: "Now playing" }, { timeout: 3000 });

    // The dock was never tapped, so the room's song is not owed back.
    await preListenFirstRow(user);

    expect(play).not.toHaveBeenCalled();
  });
});

describe("the crowd's now-playing card", () => {
  function nowPlayingRoom(
    nowPlaying: Partial<NonNullable<PublicSession["nowPlaying"]>> = {},
  ): PublicSession {
    return {
      id: "ABC123",
      name: "Room",
      djName: "DJ Owl",
      djAvatarUrl: null,
      djTagline: "",
      tipLinks: { cashApp: null, venmo: null },
      venue: "",
      createdAt: new Date().toISOString(),
      revision: 2,
      totalVotes: 2,
      guestCount: 1,
      votedTrackIds: [],
      anonymousVoteUsed: false,
      nowPlaying: {
        trackId: "track-two",
        title: "Second Track",
        artist: "Artist B",
        previewUrl: "/api/tracks/track-two/preview",
        artworkUrl: null,
        durationMs: null,
        source: null,
        startedAt: new Date(Date.now() - 10_000).toISOString(),
        ...nowPlaying,
      },
      voters: [],
      tracks: [
        tracks[0],
        { ...tracks[1], playedAt: new Date().toISOString(), cooldown: 2 },
      ],
    };
  }

  it("shows the live track and controls the same player as the bottom dock", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ session: nowPlayingRoom() })),
    );

    render(<Dashboard initialSessionId="ABC123" />);

    const card = await screen.findByRole("button", {
      name: "Listen to Second Track",
    });
    expect(screen.getByText("Live · DJ Owl Radio")).toBeInTheDocument();
    expect(within(card).getByText("Now playing")).toBeInTheDocument();
    expect(within(card).getByText("Second Track")).toBeInTheDocument();
    const cardWaveform = card.querySelector(".waveform");
    if (!cardWaveform) throw new Error("no card waveform");
    expect(cardWaveform).not.toHaveClass("is-playing");
    const dock = screen.getByRole("region", { name: "Now playing" });
    expect(within(dock).getByText("Second Track")).toBeInTheDocument();
    expect(document.querySelectorAll("audio")).toHaveLength(1);

    fireEvent.click(card);
    const audio = document.querySelector("audio");
    if (!audio) throw new Error("no shared audio element");
    expect(play).toHaveBeenCalledTimes(1);
    expect(audio.src).toContain("/api/tracks/track-two/preview");

    fireEvent.play(audio);
    await waitFor(() =>
      expect(card).toHaveAccessibleName("Pause Second Track"),
    );
    expect(cardWaveform).toHaveClass("is-playing");
    expect(within(card).getByText("Playing")).toBeInTheDocument();
    expect(
      within(dock).getByRole("button", { name: "Pause the DJ's song" }),
    ).toBeInTheDocument();
  });

  it("offers tipping from the live track card regardless of the viewer's vote", async () => {
    const user = userEvent.setup();
    const room = nowPlayingRoom();
    room.tipLinks = { cashApp: "https://cash.app/$DJOwl", venmo: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ session: room })),
    );

    render(<Dashboard initialSessionId="ABC123" />);

    const tip = await screen.findByRole("button", {
      name: "Open tip options for now playing Second Track by Artist B",
    });
    await user.click(tip);

    const dialog = screen.getByRole("dialog", { name: "Tip for this pick" });
    expect(within(dialog).getByText("Second Track")).toBeInTheDocument();
    expect(within(dialog).getByText("Artist B")).toBeInTheDocument();
  });

  it("leaves the tip on the card, not twice, for the song on now", async () => {
    const room = nowPlayingRoom();
    room.tipLinks = { cashApp: "https://cash.app/$DJOwl", venmo: null };
    room.tipEligibleTrackIds = ["track-one", "track-two"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ session: room })),
    );

    render(<Dashboard initialSessionId="ABC123" />);

    expect(
      await screen.findByRole("button", {
        name: "Open tip options for now playing Second Track by Artist B",
      }),
    ).toBeInTheDocument();
    // The card above the ballot already carries track-two's tip, so its row
    // stays quiet rather than opening the same sheet from two buttons.
    expect(
      screen.queryByRole("button", {
        name: "Open tip options for Second Track by Artist B, row 2",
      }),
    ).not.toBeInTheDocument();
    // A saved pick that is not on now keeps its row button.
    expect(
      screen.getByRole("button", {
        name: "Open tip options for First Track by Artist A, row 1",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Tip for this pick")).toHaveLength(2);
  });

  it("offers the DJ no tip on the room they host", async () => {
    const user = userEvent.setup();
    const room = nowPlayingRoom();
    room.tipLinks = { cashApp: "https://cash.app/$DJOwl", venmo: null };
    room.tipEligibleTrackIds = ["track-one", "track-two"];
    window.localStorage.setItem("upnext-account-token", "host-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/accounts") {
          return Response.json({
            account: { id: "host", pseudonym: "DJ Owl", phoneLast4: "1234" },
          });
        }
        if (url === "/api/sessions") {
          return Response.json({
            activeRoom: { session: room, hostKey: "host-key" },
            guestBaseUrl: "https://upnext.example",
          });
        }
        return Response.json({ session: room });
      }),
    );

    render(<Dashboard />);

    await user.click(
      await screen.findByRole("button", { name: "Crowd view" }, { timeout: 3000 }),
    );

    // The room is live, not a preview, but the tip links are the DJ's own.
    expect(await screen.findByText("Live · DJ Owl Radio")).toBeInTheDocument();
    expect(screen.queryByText("Tip for this pick")).not.toBeInTheDocument();
  });

  it("goes quiet when the room has played past the preview", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    // The DJ has had it on far longer than the 30s preview runs for.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          session: nowPlayingRoom({
            startedAt: new Date(Date.now() - 300_000).toISOString(),
          }),
        }),
      ),
    );

    render(<Dashboard initialSessionId="ABC123" />);

    const card = await screen.findByRole("button", {
      name: "Listen to Second Track",
    });
    fireEvent.click(card);
    const audio = document.querySelector("audio");
    if (!audio) throw new Error("no shared audio element");
    Object.defineProperty(audio, "duration", { value: 30, configurable: true });
    fireEvent.loadedMetadata(audio);

    await waitFor(() =>
      expect(card).toHaveAccessibleName("Second Track has finished"),
    );
    expect(within(card).getByText("Finished")).toBeInTheDocument();
    expect(card).toBeDisabled();
  });

  it("offers a retry when the preview will not play", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ session: nowPlayingRoom() })),
    );

    render(<Dashboard initialSessionId="ABC123" />);

    const card = await screen.findByRole("button", {
      name: "Listen to Second Track",
    });
    fireEvent.click(card);
    const audio = document.querySelector("audio");
    if (!audio) throw new Error("no shared audio element");
    fireEvent.error(audio);

    await waitFor(() =>
      expect(card).toHaveAccessibleName("Retry Second Track"),
    );
    expect(within(card).getByText("Tap to retry")).toBeInTheDocument();
    expect(card).toBeEnabled();
  });

  it("says so when the live track has no audio at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ session: nowPlayingRoom({ previewUrl: null }) }),
      ),
    );

    render(<Dashboard initialSessionId="ABC123" />);

    const card = await screen.findByRole("button", {
      name: "Second Track has no audio",
    });
    expect(within(card).getByText("No audio")).toBeInTheDocument();
    expect(card).toBeDisabled();
  });
});

describe("the room-wide face stack in the booth", () => {
  it("shows who is in the room under the Crowd queue title", async () => {
    window.localStorage.setItem("upnext-account-token", "host-token");
    const room: PublicSession = {
      id: "ABC123",
      name: "Room",
      djName: "DJ Owl",
      djAvatarUrl: null,
      djTagline: "",
      tipLinks: { cashApp: null, venmo: null },
      venue: "",
      createdAt: new Date().toISOString(),
      revision: 1,
      totalVotes: 9,
      guestCount: 8,
      votedTrackIds: [],
      anonymousVoteUsed: false,
      nowPlaying: null,
      voters: [{ name: "Delia Perla", avatarUrl: null }, { name: "Amyr", avatarUrl: null }, { name: null, avatarUrl: null }],
      tracks,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/accounts") {
          return Response.json({
            account: { id: "host", pseudonym: "DJ", phoneLast4: "1234" },
          });
        }
        if (url === "/api/sessions") {
          return Response.json({
            activeRoom: { session: room, hostKey: "host-key" },
            guestBaseUrl: "https://upnext.example",
          });
        }
        return Response.json({ session: room });
      }),
    );

    render(<Dashboard />);
    const heading = await screen.findByRole("heading", { name: "Crowd queue" });
    const stack = within(heading.parentElement as HTMLElement).getByLabelText(
      "In the room Delia Perla, Amyr and 6 others",
    );
    expect(within(stack).getByTitle("Delia Perla")).toHaveTextContent("D");
    expect(within(stack).getByText("+5")).toBeInTheDocument();
  });
});

describe("the room-wide face stack on the guest page", () => {
  it("shows who is in the room under the ballot title", async () => {
    const room: PublicSession = {
      id: "ABC123",
      name: "Room",
      djName: "DJ Owl",
      djAvatarUrl: null,
      djTagline: "",
      tipLinks: { cashApp: null, venmo: null },
      venue: "",
      createdAt: new Date().toISOString(),
      revision: 1,
      totalVotes: 9,
      guestCount: 8,
      votedTrackIds: [],
      anonymousVoteUsed: false,
      nowPlaying: null,
      voters: [{ name: "Delia Perla", avatarUrl: null }, { name: "Amyr", avatarUrl: null }, { name: null, avatarUrl: null }],
      tracks,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ session: room })),
    );

    render(<Dashboard initialSessionId="ABC123" />);
    const heading = await screen.findByRole("heading", { name: "Make your picks" });
    const stack = within(heading.parentElement as HTMLElement).getByLabelText(
      "In the room Delia Perla, Amyr and 6 others",
    );
    expect(within(stack).getByTitle("Amyr")).toHaveTextContent("A");
    expect(within(stack).getByText("+5")).toBeInTheDocument();
  });
});

describe("the faces behind a row's votes", () => {
  const withVoters = (voters: SessionTrack["voters"], votes: number): SessionTrack => ({
    ...tracks[0],
    voters,
    votes,
  });

  it("shows an initial per named voter, a blank bubble per anonymous one, and the overflow", () => {
    render(
      <QueueList
        tracks={[withVoters([{ name: "Amyr", avatarUrl: null }, { name: "Nathan Krishnan", avatarUrl: null }, { name: null, avatarUrl: null }], 173)]}
      />,
    );
    const stack = screen.getByLabelText("Voted by Amyr, Nathan Krishnan and 171 others");
    expect(within(stack).getByTitle("Amyr")).toHaveTextContent("A");
    expect(within(stack).getByTitle("Nathan Krishnan")).toHaveTextContent("N");
    expect(within(stack).getByTitle("Guest")).toBeInTheDocument();
    expect(within(stack).getByText("+170")).toBeInTheDocument();
    expect(within(stack).getByText("Amyr, Nathan Krishnan and 171 others")).toBeInTheDocument();
  });

  it("reads naturally for the small cases", () => {
    const { rerender } = render(<QueueList tracks={[withVoters([{ name: "Amyr", avatarUrl: null }], 1)]} />);
    expect(screen.getByText("Amyr")).toBeInTheDocument();
    rerender(<QueueList tracks={[withVoters([{ name: "Amyr", avatarUrl: null }, { name: "Nathan", avatarUrl: null }], 2)]} />);
    expect(screen.getByText("Amyr and Nathan")).toBeInTheDocument();
    rerender(<QueueList tracks={[withVoters([{ name: "Amyr", avatarUrl: null }, { name: null, avatarUrl: null }], 2)]} />);
    expect(screen.getByText("Amyr and 1 other")).toBeInTheDocument();
    rerender(<QueueList tracks={[withVoters([{ name: null, avatarUrl: null }], 1)]} />);
    expect(screen.getByText("1 guest voted")).toBeInTheDocument();
    rerender(<QueueList tracks={[withVoters([], 0)]} />);
    expect(screen.queryByText(/voted/)).not.toBeInTheDocument();
  });
});

describe("auto-advance in the booth", () => {
  it("puts the crowd pick on when the song runs out and the DJ does nothing", async () => {
    window.localStorage.setItem("upnext-account-token", "host-token");
    const room: PublicSession = {
      id: "ABC123",
      name: "Room",
      djName: "DJ Owl",
      djAvatarUrl: null,
      djTagline: "",
      tipLinks: { cashApp: null, venmo: null },
      venue: "",
      createdAt: "2026-08-26T00:00:00.000Z",
      revision: 3,
      totalVotes: 0,
      guestCount: 0,
      votedTrackIds: [],
      anonymousVoteUsed: false,
      voters: [],
      nowPlaying: {
        trackId: "track-one",
        title: "First Track",
        artist: "Artist A",
        previewUrl: "/api/tracks/track-one/preview",
        artworkUrl: null,
        durationMs: null,
        source: null,
        // Put on a minute ago: a 30-second song is long over.
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      tracks: [{ ...tracks[0], playedAt: "2026-08-26T00:00:00.000Z", cooldown: 2 }, tracks[1]],
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === "/api/accounts") {
          return Response.json({ account: { id: "host", pseudonym: "DJ", phoneLast4: "1234" } });
        }
        if (url === "/api/sessions") {
          return Response.json({
            activeRoom: { session: room, hostKey: "host-key" },
            guestBaseUrl: "https://upnext.example",
          });
        }
        if (url.endsWith("/now-playing")) {
          return Response.json({
            session: {
              ...room,
              revision: 4,
              nowPlaying: { ...room.nowPlaying!, trackId: "track-two", title: "Second Track" },
            },
          });
        }
        return Response.json({ session: room });
      }),
    );
    // jsdom's <audio> never loads anything; a bare element is enough to
    // capture the probe and hand it a duration.
    const created: HTMLAudioElement[] = [];
    vi.stubGlobal(
      "Audio",
      function FakeAudio(this: unknown, src?: string) {
        const element = document.createElement("audio");
        if (src) element.src = src;
        created.push(element);
        return element;
      },
    );
    render(<Dashboard />);
    await screen.findByText("First Track", { selector: ".now-playing-copy strong" }, { timeout: 3000 });

    // The booth probes the song's metadata to learn how long it is.
    const probe = await waitFor(() => {
      const found = created.find((audio) => audio.src.endsWith("/api/tracks/track-one/preview"));
      if (!found) throw new Error("no probe yet");
      return found;
    });
    Object.defineProperty(probe, "duration", { configurable: true, value: 30 });
    probe.onloadedmetadata?.(new Event("loadedmetadata"));

    await screen.findByText("Second Track", { selector: ".now-playing-copy strong" });
    const change = calls.find((call) => call.url.endsWith("/now-playing"));
    expect(JSON.parse(String(change?.init?.body))).toEqual({
      trackId: "next",
      fromTrackId: "track-one",
    });
  });
});

describe("auto-advance timing", () => {
  function mountBooth(options: {
    startedSecondsAgo: number;
    serverDate?: Date;
    durationMs?: number | null;
  }) {
    window.localStorage.setItem("upnext-account-token", "host-token");
    const room: PublicSession = {
      id: "ABC123",
      name: "Room",
      djName: "DJ Owl",
      djAvatarUrl: null,
      djTagline: "",
      tipLinks: { cashApp: null, venmo: null },
      venue: "",
      createdAt: "2026-08-26T00:00:00.000Z",
      revision: 3,
      totalVotes: 0,
      guestCount: 0,
      votedTrackIds: [],
      anonymousVoteUsed: false,
      voters: [],
      nowPlaying: {
        trackId: "track-one",
        title: "First Track",
        artist: "Artist A",
        previewUrl: "/api/tracks/track-one/preview",
        artworkUrl: null,
        durationMs: options.durationMs ?? null,
        source: null,
        startedAt: new Date(Date.now() - options.startedSecondsAgo * 1000).toISOString(),
      },
      tracks: [{ ...tracks[0], playedAt: "2026-08-26T00:00:00.000Z", cooldown: 2 }, tracks[1]],
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const headers: Record<string, string> = options.serverDate
      ? { date: options.serverDate.toUTCString() }
      : {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === "/api/accounts") {
          return Response.json({ account: { id: "host", pseudonym: "DJ", phoneLast4: "1234" } });
        }
        if (url === "/api/sessions") {
          return Response.json({
            activeRoom: { session: room, hostKey: "host-key" },
            guestBaseUrl: "https://upnext.example",
          });
        }
        if (url.endsWith("/now-playing")) return Response.json({ session: room });
        return Response.json({ session: room }, { headers });
      }),
    );
    const created: HTMLAudioElement[] = [];
    vi.stubGlobal(
      "Audio",
      function FakeAudio(this: unknown, src?: string) {
        const element = document.createElement("audio");
        if (src) element.src = src;
        created.push(element);
        return element;
      },
    );
    render(<Dashboard />);
    return {
      calls,
      async probe() {
        await screen.findByText("First Track", { selector: ".now-playing-copy strong" }, { timeout: 3000 });
        return waitFor(() => {
          const found = created.find((audio) => audio.src.endsWith("/api/tracks/track-one/preview"));
          if (!found) throw new Error("no probe yet");
          return found;
        });
      },
      advances: () => calls.filter((call) => call.url.endsWith("/now-playing")),
      probed: () =>
        created.filter((audio) =>
          audio.src.endsWith("/api/tracks/track-one/preview"),
        ),
    };
  }

  it("follows an imported song's real length, not its preview clip", async () => {
    // The regression this guards: an imported row pre-listens through a clip
    // of about thirty seconds, so probing what it plays would cut a
    // four-minute track off after the snippet while the DJ is still on it.
    const booth = mountBooth({ startedSecondsAgo: 60, durationMs: 240_000 });
    await screen.findByText(
      "First Track",
      { selector: ".now-playing-copy strong" },
      { timeout: 3000 },
    );

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(booth.advances()).toHaveLength(0);
    // And it did not go looking: the length was already known.
    expect(booth.probed()).toHaveLength(0);
  });

  it("advances once an imported song's real length has run out", async () => {
    const booth = mountBooth({ startedSecondsAgo: 300, durationMs: 240_000 });
    await waitFor(() => expect(booth.advances()).not.toHaveLength(0), {
      timeout: 3000,
    });
    expect(
      JSON.parse(String(booth.advances()[0].init?.body)),
    ).toMatchObject({ trackId: "next", fromTrackId: "track-one" });
  });

  it("waits while the song is still going", async () => {
    const booth = mountBooth({ startedSecondsAgo: 5 });
    const probe = await booth.probe();
    Object.defineProperty(probe, "duration", { configurable: true, value: 30 });
    probe.onloadedmetadata?.(new Event("loadedmetadata"));

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(booth.advances()).toHaveLength(0);
  });

  it("trusts the server's clock over the booth's", async () => {
    // By the booth's clock the song ended a minute ago; the server says it
    // started only just now (its Date header runs two minutes behind).
    const booth = mountBooth({
      startedSecondsAgo: 60,
      serverDate: new Date(Date.now() - 120_000),
    });
    const probe = await booth.probe();
    // Let a poll land so the offset is learned before the length arrives.
    await waitFor(() =>
      expect(booth.calls.some((call) => call.url.startsWith("/api/sessions/ABC123"))).toBe(true),
    );
    Object.defineProperty(probe, "duration", { configurable: true, value: 30 });
    probe.onloadedmetadata?.(new Event("loadedmetadata"));

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(booth.advances()).toHaveLength(0);
  });
});

describe("fitting faces to the screen", () => {
  it("keeps a slot for +N only when not everyone fits", () => {
    // 20px faces overlapping by 6px: 100px holds 6 slots.
    expect(facesThatFit({ width: 100, faceWidth: 20, overlap: 6, count: 6 })).toBe(6);
    expect(facesThatFit({ width: 100, faceWidth: 20, overlap: 6, count: 20 })).toBe(5);
    expect(facesThatFit({ width: 100, faceWidth: 20, overlap: 6, count: 3 })).toBe(3);
    // Too narrow for even one full face still shows one.
    expect(facesThatFit({ width: 10, faceWidth: 20, overlap: 6, count: 20 })).toBe(1);
    // Nothing measured yet: show everything rather than nothing.
    expect(facesThatFit({ width: 0, faceWidth: 20, overlap: 6, count: 20 })).toBe(20);
  });

  it("shows as many faces as the row has room for and folds the rest into +N", async () => {
    // jsdom has no layout; give the stack 100px and each face 20px, and a
    // ResizeObserver that reports once.
    const widths = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return (this as HTMLElement).classList.contains("voter-stack") ? 100 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() {
        return (this as HTMLElement).classList.contains("voter-face") ? 20 : 0;
      },
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: () => void) {}
        observe() {
          this.callback();
        }
        disconnect() {}
      },
    );
    try {
      const voters = Array.from({ length: 20 }, (_, index) => ({ name: `Guest ${index}`, avatarUrl: null }));
      render(<QueueList tracks={[{ ...tracks[0], votes: 25, voters }]} />);

      const stack = screen.getByRole("group", { name: /voted by/i });
      const faces = stack.querySelectorAll(".voter-face:not(.is-more)");
      // 100px at 14px per overlapping face is six slots; one goes to +N.
      expect(faces).toHaveLength(5);
      expect(within(stack).getByText("+20")).toBeInTheDocument();
      // The sentence still speaks for the whole vote, not just the faces shown.
      expect(within(stack).getByText(/Guest 0, Guest 1 and 23 others/)).toBeInTheDocument();
    } finally {
      // Put the prototype back exactly as it was: restore an own descriptor
      // if there was one, otherwise remove ours so jsdom's own getter shows.
      for (const name of ["clientWidth", "offsetWidth"] as const) {
        const original = widths[name];
        if (original) Object.defineProperty(HTMLElement.prototype, name, original);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    }
  });
});

describe("the first screen's headline", () => {
  it("sells the product to a curator or DJ arriving cold", () => {
    render(<IdentityGate joiningRoom={false} onSave={vi.fn()} onLogin={vi.fn()} />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /You curate\.\s*Your fans decide what to play next\./,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/For music curators and DJs/)).toBeInTheDocument();
    expect(screen.queryByText(/Pick a name/)).not.toBeInTheDocument();
  });

  it("just asks a fan who followed a session link for a name", () => {
    render(<IdentityGate joiningRoom onSave={vi.fn()} onLogin={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 1, name: /Pick a name/ })).toBeInTheDocument();
    expect(screen.getByText(/Join the session/)).toBeInTheDocument();
    expect(screen.queryByText(/Your fans decide/)).not.toBeInTheDocument();
  });
});

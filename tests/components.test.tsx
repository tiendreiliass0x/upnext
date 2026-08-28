// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dashboard, {
  IdentityGate,
  QueueList,
} from "@/components/Dashboard";
import type { PublicSession, SessionTrack } from "@/lib/sessions";

const tracks: SessionTrack[] = [
  {
    id: "track-one",
    title: "First Track",
    artist: "Artist A",
    votes: 2,
    position: 0,
    previewUrl: "/api/tracks/track-one/preview",
  },
  {
    id: "track-two",
    title: "Second Track",
    artist: "Artist B",
    votes: 1,
    position: 1,
    previewUrl: "/api/tracks/track-two/preview",
  },
];

class MockAudio {
  static instances: MockAudio[] = [];

  src: string;
  preload = "";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn();

  constructor(src: string) {
    this.src = src;
    MockAudio.instances.push(this);
  }
}

beforeEach(() => {
  window.localStorage.clear();
  MockAudio.instances = [];
  vi.stubGlobal("Audio", MockAudio);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("identity onboarding", () => {
  it("submits a phone number and self-chosen pseudonym", async () => {
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
    await user.type(screen.getByLabelText(/Pseudonym/), "Night Owl");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("+32 470 12 34 56", "Night Owl"),
    );
    expect(
      screen.getByText(/phone number identifies your account/i),
    ).toBeInTheDocument();
  });

  it("shows account errors without leaving the form", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error("Phone already registered"));
    render(
      <IdentityGate joiningRoom onSave={onSave} onLogin={vi.fn()} />,
    );

    await user.type(screen.getByLabelText(/Phone number/), "+32470000000");
    await user.type(screen.getByLabelText(/Pseudonym/), "Mint Fox");
    await user.click(screen.getByRole("button", { name: /join room/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Phone already registered",
    );
  });

  it("switches to phone-only login", async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn().mockResolvedValue(undefined);
    render(
      <IdentityGate joiningRoom onSave={vi.fn()} onLogin={onLogin} />,
    );

    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(screen.queryByLabelText(/Pseudonym/)).not.toBeInTheDocument();
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
      venue: "Test Venue",
      createdAt: "2026-08-26T00:00:00.000Z",
      revision: totalVotes,
      totalVotes,
      guestCount: totalVotes > 0 ? 1 : 0,
      votedTrackIds,
      anonymousVoteUsed: votedTrackIds.length > 0,
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
            venue: "",
            createdAt: "2026-08-26T00:00:00.000Z",
            revision: 0,
            totalVotes: 0,
            guestCount: 0,
            votedTrackIds: [],
            anonymousVoteUsed: false,
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
    venue: "Test Venue",
    createdAt: "2026-08-26T00:00:00.000Z",
    revision,
    totalVotes: 0,
    guestCount: 0,
    votedTrackIds: [],
    anonymousVoteUsed: false,
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
    venue: "Test Venue",
    createdAt: "2026-08-26T00:00:00.000Z",
    revision: 0,
    totalVotes: 0,
    guestCount: 0,
    votedTrackIds: [],
    anonymousVoteUsed: false,
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

describe("queue interactions", () => {
  it("plays one preview at a time and ignores stale media events", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<QueueList tracks={tracks} />);
    const firstButton = screen.getByRole("button", {
      name: /play 30-second preview of first track/i,
    });
    const secondButton = screen.getByRole("button", {
      name: /play 30-second preview of second track/i,
    });

    await user.click(firstButton);
    await waitFor(() => expect(firstButton).toHaveAttribute("aria-pressed", "true"));
    const firstAudio = MockAudio.instances[0];
    const staleError = firstAudio.onerror;

    await user.click(secondButton);
    await waitFor(() =>
      expect(secondButton).toHaveAttribute("aria-pressed", "true"),
    );
    expect(firstAudio.pause).toHaveBeenCalled();
    staleError?.();
    expect(secondButton).toHaveAttribute("aria-pressed", "true");

    const secondAudio = MockAudio.instances[1];
    unmount();
    expect(secondAudio.pause).toHaveBeenCalled();
    expect(secondAudio.removeAttribute).toHaveBeenCalledWith("src");
  });

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
});

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dashboard, { prepareAvatarFile, QueueList } from "@/components/Dashboard";
import type { PublicAccount } from "@/lib/accounts";
import type { PublicSession, SessionTrack } from "@/lib/sessions";

vi.mock("react-qr-code", () => ({
  default: ({ value }: { value: string }) => <svg data-encoded-value={value} />,
}));

const signedIn: PublicAccount = {
  id: "host",
  pseudonym: "Night Owl",
  phoneLast4: "3456",
  avatarUrl: null,
  tagline: "",
};

/**
 * A booth with nobody in a room: enough for the header chip and the sheet it
 * opens. `account` is what /api/accounts answers with, and `onRequest`
 * receives every call the sheet makes so a test can answer and inspect it.
 */
function bootDashboard(
  account: PublicAccount,
  onRequest: (url: string, init?: RequestInit) => Response | undefined,
) {
  window.localStorage.setItem("upnext-account-token", "host-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const answer = onRequest(url, init);
      if (answer) return answer;
      if (url === "/api/accounts") return Response.json({ account });
      if (url === "/api/sessions") return Response.json({ activeRoom: null });
      return Response.json({});
    }),
  );
  return render(<Dashboard />);
}

function pngFile(name = "me.png", size = 32) {
  const body = new Uint8Array(size);
  body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new File([body], name, { type: "image/png" });
}

async function openProfile(user: ReturnType<typeof userEvent.setup>) {
  const chip = await screen.findByRole("button", { name: /Edit your profile/ });
  await user.click(chip);
  return screen.getByRole("dialog", { name: "How the room sees you" });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the profile sheet", () => {
  it("opens from the header chip and shows what the room sees", async () => {
    const user = userEvent.setup();
    bootDashboard(
      { ...signedIn, tagline: "Vinyl only" },
      () => undefined,
    );

    const sheet = await openProfile(user);

    expect(within(sheet).getByLabelText(/Username/)).toHaveValue("Night Owl");
    expect(within(sheet).getByLabelText(/Tagline/)).toHaveValue("Vinyl only");
    expect(within(sheet).getByText(/Phone ending 3456/)).toBeInTheDocument();
    // No picture yet: the lettered bubble stands in for one.
    expect(within(sheet).getByTitle("Night Owl")).toHaveTextContent("N");
    expect(
      within(sheet).queryByRole("button", { name: /Remove/ }),
    ).not.toBeInTheDocument();
  });

  it("saves a new username and renames the chip behind it", async () => {
    const user = userEvent.setup();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    bootDashboard(signedIn, (url, init) => {
      if (url === "/api/accounts" && init?.method === "PATCH") {
        calls.push({ url, init });
        return Response.json({ account: { ...signedIn, pseudonym: "Mint Fox" } });
      }
      return undefined;
    });

    const sheet = await openProfile(user);
    const username = within(sheet).getByLabelText(/Username/);
    await user.clear(username);
    await user.type(username, "Mint Fox");
    await user.click(within(sheet).getByRole("button", { name: /Save profile/ }));

    await screen.findByText("Profile saved.");
    // Only the field the form changed. Sending the untouched one too lets a
    // tab left open overwrite a value it was never asked to touch.
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      pseudonym: "Mint Fox",
    });
    expect(
      await screen.findByRole("button", { name: /Signed in as Mint Fox/ }),
    ).toBeInTheDocument();
  });

  it("will not offer to save a username the server would refuse", async () => {
    const user = userEvent.setup();
    bootDashboard(signedIn, () => undefined);

    const sheet = await openProfile(user);
    const username = within(sheet).getByLabelText(/Username/);
    await user.clear(username);
    await user.type(username, "x");

    expect(within(sheet).getByText(/between 2 and 24 characters/)).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: /Save profile/ })).toBeDisabled();
  });

  it("sends a picked picture and shows the picture that comes back", async () => {
    const user = userEvent.setup();
    const withPicture = { ...signedIn, avatarUrl: "/api/avatars/abc.png" };
    let sent: RequestInit | undefined;
    bootDashboard(signedIn, (url, init) => {
      if (url === "/api/accounts/avatar" && init?.method === "POST") {
        sent = init;
        return Response.json({ account: withPicture });
      }
      return undefined;
    });

    const sheet = await openProfile(user);
    await user.upload(within(sheet).getByLabelText(/Add a picture/), pngFile());

    await screen.findByText("Picture updated.");
    expect((sent?.body as FormData).get("file")).toBeInstanceOf(File);
    const pictures = screen.getAllByRole("presentation", { hidden: true });
    expect(pictures.length).toBeGreaterThan(0);
    expect(pictures[0]).toHaveAttribute("src", "/api/avatars/abc.png");
  });

  it("refuses an oversized picture before spending the wifi on it", async () => {
    const user = userEvent.setup();
    let requested = false;
    bootDashboard(signedIn, (url) => {
      if (url === "/api/accounts/avatar") requested = true;
      return undefined;
    });

    const sheet = await openProfile(user);
    await user.upload(
      within(sheet).getByLabelText(/Add a picture/),
      pngFile("huge.png", 3 * 1024 * 1024),
    );

    expect(
      await screen.findByText("Profile pictures must be smaller than 2 MB."),
    ).toBeInTheDocument();
    expect(requested).toBe(false);
  });

  it("removes a picture and goes back to the lettered bubble", async () => {
    const user = userEvent.setup();
    let method = "";
    bootDashboard({ ...signedIn, avatarUrl: "/api/avatars/abc.png" }, (url, init) => {
      if (url === "/api/accounts/avatar") {
        method = String(init?.method);
        return Response.json({ account: signedIn });
      }
      return undefined;
    });

    const sheet = await openProfile(user);
    await user.click(within(sheet).getByRole("button", { name: /Remove/ }));

    await screen.findByText("Picture removed.");
    expect(method).toBe("DELETE");
    expect(screen.queryByRole("presentation", { hidden: true })).not.toBeInTheDocument();
  });

  it("says what went wrong and keeps the sheet open", async () => {
    const user = userEvent.setup();
    let sent: RequestInit | undefined;
    bootDashboard(signedIn, (url, init) => {
      if (url === "/api/accounts" && init?.method === "PATCH") {
        sent = init;
        return Response.json({ error: "That name is taken." }, { status: 409 });
      }
      return undefined;
    });

    const sheet = await openProfile(user);
    await user.type(within(sheet).getByLabelText(/Tagline/), "Vinyl only");
    await user.click(within(sheet).getByRole("button", { name: /Save profile/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That name is taken.");
    expect(JSON.parse(String(sent?.body))).toEqual({ tagline: "Vinyl only" });
    expect(screen.getByRole("dialog", { name: "How the room sees you" })).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    bootDashboard(signedIn, () => undefined);

    await openProfile(user);
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "How the room sees you" }),
      ).not.toBeInTheDocument(),
    );
  });
});

const ballotTrack: SessionTrack = {
  id: "track-one",
  title: "First Track",
  artist: "Artist A",
  votes: 2,
  position: 0,
  previewUrl: null,
  artworkUrl: null,
  durationMs: null,
  source: null,
  playedAt: null,
  cooldown: 0,
  voters: [],
};

describe("a picture where an initial used to be", () => {
  it("fills a row's face with the voter's picture and leaves the rest lettered", () => {
    render(
      <QueueList
        tracks={[
          {
            ...ballotTrack,
            votes: 3,
            voters: [
              { name: "Amyr", avatarUrl: "/api/avatars/amyr.png" },
              { name: "Nathan", avatarUrl: null },
              { name: null, avatarUrl: null },
            ],
          },
        ]}
      />,
    );

    const stack = screen.getByLabelText(/Voted by Amyr, Nathan and 1 other/);
    expect(within(stack).getByTitle("Amyr").querySelector("img")).toHaveAttribute(
      "src",
      "/api/avatars/amyr.png",
    );
    // A voter with no picture still gets the letter, and an anonymous vote is
    // still the one blank bubble it always was.
    expect(within(stack).getByTitle("Nathan")).toHaveTextContent("N");
    expect(within(stack).getByTitle("Guest").querySelector("img")).toBeNull();
  });

  it("introduces the DJ under the room title, with their picture and tagline", async () => {
    const room: PublicSession = {
      id: "ABC123",
      name: "Friday After Dark",
      djName: "DJ Owl",
      djAvatarUrl: "/api/avatars/owl.png",
      djTagline: "Vinyl only",
      tipLinks: { cashApp: null, venmo: null },
      venue: "",
      createdAt: new Date().toISOString(),
      revision: 1,
      totalVotes: 0,
      guestCount: 0,
      votedTrackIds: [],
      anonymousVoteUsed: false,
      nowPlaying: null,
      voters: [],
      tracks: [ballotTrack],
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ session: room })));

    render(<Dashboard initialSessionId="ABC123" />);

    const host = await screen.findByText("DJ Owl");
    const byline = host.closest(".guest-host") as HTMLElement;
    expect(within(byline).getByText("Vinyl only")).toBeInTheDocument();
    expect(within(byline).getByTitle("DJ Owl").querySelector("img")).toHaveAttribute(
      "src",
      "/api/avatars/owl.png",
    );
  });
});

describe("shrinking a picture before it is sent", () => {
  it("hands the file back untouched when the browser cannot resize", async () => {
    // jsdom has no canvas and no createImageBitmap. The upload still has to
    // go: the route's own limits are the check, this is the optimisation.
    const original = pngFile("original.png", 4096);
    await expect(prepareAvatarFile(original)).resolves.toBe(original);
  });

  it("leaves a picture that is already small enough alone", async () => {
    const drawn: Array<[number, number]> = [];
    vi.stubGlobal("createImageBitmap", async () => ({
      width: 128,
      height: 96,
      close() {},
    }));
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (tag !== "canvas") throw new Error("unexpected element");
      drawn.push([0, 0]);
      return {} as HTMLElement;
    }) as typeof document.createElement);

    const small = pngFile("small.png", 512);
    await expect(prepareAvatarFile(small)).resolves.toBe(small);
    // Re-encoding a picture that already fits would only lose quality.
    expect(drawn).toHaveLength(0);
  });

  it("shrinks a phone camera original to something a face can use", async () => {
    let drawnTo: { width: number; height: number } | null = null;
    vi.stubGlobal("createImageBitmap", async () => ({
      width: 4032,
      height: 3024,
      close() {},
    }));
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => undefined }),
      toBlob: (done: (blob: Blob) => void) => {
        drawnTo = { width: canvas.width, height: canvas.height };
        done(new Blob([new Uint8Array(2048)], { type: "image/jpeg" }));
      },
    };
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
      tag === "canvas" ? canvas : ({} as HTMLElement)) as typeof document.createElement);

    const huge = pngFile("huge.png", 5 * 1024 * 1024);
    const prepared = await prepareAvatarFile(huge);

    expect(prepared).not.toBe(huge);
    expect(prepared.type).toBe("image/jpeg");
    expect(prepared.size).toBeLessThan(huge.size);
    // The long side lands on the upload size and the aspect ratio holds.
    expect(drawnTo).toEqual({ width: 512, height: 384 });
  });
});

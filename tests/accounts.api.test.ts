import { describe, expect, it } from "vitest";
import { POST as accountsRoute } from "@/app/api/accounts/route";
import { POST as loginRoute } from "@/app/api/accounts/login/route";
import { createAccount } from "@/lib/accounts";
import { castAnonymousVote, createSession, getSession } from "@/lib/sessions";
import { setupTestDatabase } from "./helpers/database";

setupTestDatabase();

const voterA = "browser-aaaaaaaaaaaaaaaa";
const voterB = "browser-bbbbbbbbbbbbbbbb";

function post(path: "accounts" | "login", body: object, voterId?: string) {
  const url = path === "login" ? "http://test/api/accounts/login" : "http://test/api/accounts";
  const request = new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(voterId ? { "x-upnext-voter-id": voterId } : {}),
    },
    body: JSON.stringify(body),
  });
  return path === "login" ? loginRoute(request) : accountsRoute(request);
}

function roomWithVote(hostId: string, voterId: string) {
  const { session } = createSession({
    name: "Set",
    venue: "",
    accountId: hostId,
    requestId: crypto.randomUUID(),
    tracks: [{ title: "Opener", artist: "A" }],
  });
  const trackId = getSession(session.id)!.tracks[0].id;
  castAnonymousVote({ sessionId: session.id, trackId, voterId });
  return { sessionId: session.id, trackId };
}

describe("the second vote's account form", () => {
  it("logs a known number in from the sign-up form and keeps the account's own pseudonym", async () => {
    const host = createAccount({ phone: "+32470000301", pseudonym: "Host" });
    const { sessionId, trackId } = roomWithVote(host.id, voterA);

    const response = await post("accounts", { phone: "+32 470 00 03 01", pseudonym: "Also Host" }, voterA);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.loggedIn).toBe(true);
    expect(data.token).toBe(host.authToken);
    // Knowing a number does not rename its owner.
    expect(data.account.pseudonym).toBe("Host");
    // The browser's free vote came along.
    expect(getSession(sessionId, host.id)!.votedTrackIds).toEqual([trackId]);
  });

  it("logs a browser that already belongs to one account into another, leaving the first's vote where it is", async () => {
    const first = createAccount({ phone: "+32470000302", pseudonym: "First" });
    const second = createAccount({ phone: "+32470000303", pseudonym: "Second" });
    const { sessionId, trackId } = roomWithVote(first.id, voterB);
    // The browser signed up as First once: its voter ID is linked, vote and all.
    const link = await post("accounts", { phone: first.phone, pseudonym: "First" }, voterB);
    expect(link.status).toBe(200);
    expect(getSession(sessionId, first.id)!.votedTrackIds).toEqual([trackId]);

    // Someone else picks up the phone and logs in as themselves.
    const response = await post("login", { phone: second.phone }, voterB);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.token).toBe(second.authToken);
    expect(getSession(sessionId, first.id)!.votedTrackIds).toEqual([trackId]);
    expect(getSession(sessionId, second.id)!.votedTrackIds).toEqual([]);
  });

  it("counts login misses toward the limit, not the crowd's logins", async () => {
    const account = createAccount({ phone: "+32470000304", pseudonym: "Regular" });

    // A whole venue logging in from one address never runs out.
    for (let i = 0; i < 120; i += 1) {
      expect((await post("login", { phone: account.phone })).status).toBe(200);
    }
    // A sweep of unknown numbers does.
    let status = 0;
    for (let i = 0; i < 100; i += 1) {
      status = (await post("login", { phone: `+3247099${String(i).padStart(4, "0")}` })).status;
      expect(status).toBe(404);
    }
    expect((await post("login", { phone: "+32470999999" })).status).toBe(429);
    // And a real login is refused while the address is throttled.
    expect((await post("login", { phone: account.phone })).status).toBe(429);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  GET as getAccount,
  POST as saveAccount,
} from "@/app/api/accounts/route";
import { POST as loginAccount } from "@/app/api/accounts/login/route";
import {
  GET as getActiveRoom,
  POST as createRoom,
} from "@/app/api/sessions/route";
import {
  DELETE as deleteRoom,
  GET as getRoom,
} from "@/app/api/sessions/[id]/route";
import { POST as vote } from "@/app/api/sessions/[id]/vote/route";
import { setupTestDatabase } from "./helpers/database";

setupTestDatabase();

type AccountResponse = {
  account: { id: string; pseudonym: string; phoneLast4: string };
  token: string;
};

function request(
  url: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    voterId?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.voterId) headers["x-upnext-voter-id"] = options.voterId;
  return new Request(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function body<T>(response: Response) {
  return (await response.json()) as T;
}

async function register(phone: string, pseudonym: string) {
  const response = await saveAccount(
    request("http://localhost/api/accounts", {
      method: "POST",
      body: { phone, pseudonym },
    }),
  );
  expect(response.status).toBe(200);
  return body<AccountResponse>(response);
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("guest base URL", () => {
  const original = process.env.APP_PUBLIC_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.APP_PUBLIC_URL;
    else process.env.APP_PUBLIC_URL = original;
  });

  async function hostAndRoom(configured: string | undefined) {
    if (configured === undefined) delete process.env.APP_PUBLIC_URL;
    else process.env.APP_PUBLIC_URL = configured;
    const host = await register("+32470000601", "Base Host");
    const created = await createRoom(
      request("http://localhost/api/sessions", {
        method: "POST",
        token: host.token,
        body: {
          name: "Base Room",
          venue: "V",
          tracks: [{ title: "A", artist: "x" }],
        },
      }),
    );
    return { host, created };
  }

  it("hands the configured URL to the host on create and on recovery", async () => {
    const { host, created } = await hostAndRoom("https://upnext.example.com/");
    expect(
      (await body<{ guestBaseUrl: string | null }>(created)).guestBaseUrl,
    ).toBe("https://upnext.example.com");

    const active = await getActiveRoom(
      request("http://localhost/api/sessions", { token: host.token }),
    );
    expect(
      (await body<{ guestBaseUrl: string | null }>(active)).guestBaseUrl,
    ).toBe("https://upnext.example.com");
  });

  it("reports null when unconfigured so the client can warn", async () => {
    const { created } = await hostAndRoom(undefined);
    expect(
      (await body<{ guestBaseUrl: string | null }>(created)).guestBaseUrl,
    ).toBeNull();
  });

  it("reports null for a misconfigured value rather than shipping it", async () => {
    const { created } = await hostAndRoom("not-a-url");
    expect(
      (await body<{ guestBaseUrl: string | null }>(created)).guestBaseUrl,
    ).toBeNull();
  });
});

describe("room conditional requests", () => {
  async function openRoom() {
    const host = await register("+32470000501", "Tag Host");
    const created = await body<{
      session: { id: string; tracks: Array<{ id: string }> };
      hostKey: string;
    }>(
      await createRoom(
        request("http://localhost/api/sessions", {
          method: "POST",
          token: host.token,
          body: {
            name: "Tagged Room",
            venue: "Room 02",
            tracks: [
              { title: "First", artist: "A" },
              { title: "Second", artist: "B" },
            ],
          },
        }),
      ),
    );
    return { host, created };
  }

  function roomRequest(
    id: string,
    options: { token?: string; voterId?: string; tag?: string } = {},
  ) {
    return getRoom(
      request(`http://localhost/api/sessions/${id}`, {
        token: options.token,
        voterId: options.voterId,
        headers: options.tag ? { "If-None-Match": options.tag } : {},
      }),
      context(id),
    );
  }

  it("answers an unchanged room with 304 and no body", async () => {
    const { host, created } = await openRoom();

    const first = await roomRequest(created.session.id, { token: host.token });
    const tag = first.headers.get("etag");
    expect(first.status).toBe(200);
    expect(tag).toBeTruthy();

    const repeated = await roomRequest(created.session.id, {
      token: host.token,
      tag: tag as string,
    });
    expect(repeated.status).toBe(304);
    expect(repeated.headers.get("etag")).toBe(tag);
    expect(await repeated.text()).toBe("");
  });

  it("returns a fresh body once a vote moves the revision", async () => {
    const { host, created } = await openRoom();
    const guest = await register("+32470000502", "Tag Guest");

    const first = await roomRequest(created.session.id, { token: host.token });
    const tag = first.headers.get("etag") as string;

    await vote(
      request(`http://localhost/api/sessions/${created.session.id}/vote`, {
        method: "POST",
        token: guest.token,
        body: { trackId: created.session.tracks[1].id, enabled: true },
      }),
      context(created.session.id),
    );

    const afterVote = await roomRequest(created.session.id, {
      token: host.token,
      tag,
    });
    expect(afterVote.status).toBe(200);
    expect(afterVote.headers.get("etag")).not.toBe(tag);
    expect(
      (await body<{ session: { totalVotes: number } }>(afterVote)).session
        .totalVotes,
    ).toBe(1);
  });

  it("never lets one viewer's tag serve another viewer's room payload", async () => {
    const { created } = await openRoom();
    const guest = await register("+32470000503", "Tag Voter");

    await vote(
      request(`http://localhost/api/sessions/${created.session.id}/vote`, {
        method: "POST",
        token: guest.token,
        body: { trackId: created.session.tracks[0].id, enabled: true },
      }),
      context(created.session.id),
    );

    const voterTag = (
      await roomRequest(created.session.id, { token: guest.token })
    ).headers.get("etag") as string;

    // Same room, same revision, different viewer: the per-viewer votedTrackIds
    // must not be short-circuited away.
    const anonymous = await roomRequest(created.session.id, {
      voterId: "conditional-anonymous-voter",
      tag: voterTag,
    });
    expect(anonymous.status).toBe(200);
    expect(
      (await body<{ session: { votedTrackIds: string[] } }>(anonymous)).session
        .votedTrackIds,
    ).toEqual([]);

    const publicView = await roomRequest(created.session.id, { tag: voterTag });
    expect(publicView.status).toBe(200);

    const sameViewer = await roomRequest(created.session.id, {
      token: guest.token,
      tag: voterTag,
    });
    expect(sameViewer.status).toBe(304);
  });

  it("prefers 404 over 304 once the room is gone", async () => {
    const { host, created } = await openRoom();
    const first = await roomRequest(created.session.id, { token: host.token });
    const tag = first.headers.get("etag") as string;

    const ended = await deleteRoom(
      request(`http://localhost/api/sessions/${created.session.id}`, {
        method: "DELETE",
        token: host.token,
        headers: { "x-upnext-host-key": created.hostKey },
      }),
      context(created.session.id),
    );
    expect(ended.status).toBe(200);

    const afterEnd = await roomRequest(created.session.id, {
      token: host.token,
      tag,
    });
    expect(afterEnd.status).toBe(404);
  });
});

describe("account API", () => {
  it("validates account input", async () => {
    const invalidPhone = await saveAccount(
      request("http://localhost/api/accounts", {
        method: "POST",
        body: { phone: "123", pseudonym: "Valid Name" },
      }),
    );
    const invalidName = await saveAccount(
      request("http://localhost/api/accounts", {
        method: "POST",
        body: { phone: "+32470000030", pseudonym: "x" },
      }),
    );

    expect(invalidPhone.status).toBe(400);
    expect(invalidName.status).toBe(400);
  });

  it("blocks duplicate registration and allows authenticated pseudonym updates", async () => {
    const registered = await register("+32470000031", "First Name");
    const takeover = await saveAccount(
      request("http://localhost/api/accounts", {
        method: "POST",
        body: { phone: "+32470000031", pseudonym: "Impostor" },
      }),
    );
    expect(takeover.status).toBe(409);
    expect(await body<{ token?: string }>(takeover)).not.toHaveProperty("token");

    const update = await saveAccount(
      request("http://localhost/api/accounts", {
        method: "POST",
        token: registered.token,
        body: { phone: "+32470000031", pseudonym: "Updated Name" },
      }),
    );
    const updated = await body<AccountResponse>(update);
    expect(update.status).toBe(200);
    expect(updated.token).toBe(registered.token);
    expect(updated.account.pseudonym).toBe("Updated Name");

    const unauthorized = await getAccount(
      request("http://localhost/api/accounts"),
    );
    const authorized = await getAccount(
      request("http://localhost/api/accounts", { token: registered.token }),
    );
    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);
    expect(await body(authorized)).not.toHaveProperty("token");
  });

  it("logs an existing account in by phone number", async () => {
    const registered = await register("+32470000037", "Returning Guest");
    const loggedIn = await loginAccount(
      request("http://localhost/api/accounts/login", {
        method: "POST",
        voterId: "returning-browser-000000000001",
        body: { phone: "+32 470 00 00 37" },
      }),
    );
    const login = await body<AccountResponse>(loggedIn);
    expect(loggedIn.status).toBe(200);
    expect(login.token).toBe(registered.token);
    expect(login.account).toEqual(registered.account);

    const unknown = await loginAccount(
      request("http://localhost/api/accounts/login", {
        method: "POST",
        body: { phone: "+32470000999" },
      }),
    );
    expect(unknown.status).toBe(404);
  });
});

describe("session API", () => {
  it("runs the authenticated room lifecycle", async () => {
    const host = await register("+32470000032", "DJ Test");
    const guest = await register("+32470000033", "Guest Test");
    const sessionPayload = {
      name: "API Room",
      venue: "Test Venue",
      requestId: "api-room-request",
      tracks: [
        { title: "Track One", artist: "Artist A" },
        { title: "Track Two", artist: "Artist B" },
      ],
    };

    const unauthorizedCreate = await createRoom(
      request("http://localhost/api/sessions", {
        method: "POST",
        body: sessionPayload,
      }),
    );
    expect(unauthorizedCreate.status).toBe(401);

    const createdResponse = await createRoom(
      request("http://localhost/api/sessions", {
        method: "POST",
        token: host.token,
        body: sessionPayload,
      }),
    );
    const created = await body<{
      session: {
        id: string;
        tracks: Array<{ id: string; title: string }>;
      };
      hostKey: string;
    }>(createdResponse);
    expect(createdResponse.status).toBe(201);

    const repeatedResponse = await createRoom(
      request("http://localhost/api/sessions", {
        method: "POST",
        token: host.token,
        body: sessionPayload,
      }),
    );
    const repeated = await body<typeof created>(repeatedResponse);
    expect(repeated.session.id).toBe(created.session.id);
    expect(repeated.hostKey).toBe(created.hostKey);

    const activeResponse = await getActiveRoom(
      request("http://localhost/api/sessions", { token: host.token }),
    );
    const active = await body<{
      activeRoom: { session: { id: string }; hostKey: string };
    }>(activeResponse);
    expect(active.activeRoom.session.id).toBe(created.session.id);

    const unauthorizedVote = await vote(
      request(`http://localhost/api/sessions/${created.session.id}/vote`, {
        method: "POST",
        body: { trackId: created.session.tracks[1].id, enabled: true },
      }),
      context(created.session.id),
    );
    expect(unauthorizedVote.status).toBe(401);

    const voteResponse = await vote(
      request(`http://localhost/api/sessions/${created.session.id}/vote`, {
        method: "POST",
        token: guest.token,
        body: { trackId: created.session.tracks[1].id, enabled: true },
      }),
      context(created.session.id.toLowerCase()),
    );
    const voted = await body<{
      session: {
        totalVotes: number;
        votedTrackIds: string[];
        tracks: Array<{ id: string }>;
      };
    }>(voteResponse);
    expect(voteResponse.status).toBe(200);
    expect(voted.session.totalVotes).toBe(1);
    expect(voted.session.tracks[0].id).toBe(created.session.tracks[1].id);
    expect(voted.session.votedTrackIds).toEqual([
      created.session.tracks[1].id,
    ]);

    const guestRoomResponse = await getRoom(
      request(`http://localhost/api/sessions/${created.session.id}`, {
        token: guest.token,
      }),
      context(created.session.id),
    );
    expect((await body<{ session: { totalVotes: number } }>(guestRoomResponse)).session.totalVotes).toBe(1);

    const deniedEnd = await deleteRoom(
      request(`http://localhost/api/sessions/${created.session.id}`, {
        method: "DELETE",
        token: guest.token,
        headers: { "x-upnext-host-key": created.hostKey },
      }),
      context(created.session.id),
    );
    expect(deniedEnd.status).toBe(403);

    const ended = await deleteRoom(
      request(`http://localhost/api/sessions/${created.session.id}`, {
        method: "DELETE",
        token: host.token,
        headers: { "x-upnext-host-key": created.hostKey },
      }),
      context(created.session.id),
    );
    expect(ended.status).toBe(200);

    const gone = await getRoom(
      request(`http://localhost/api/sessions/${created.session.id}`),
      context(created.session.id),
    );
    expect(gone.status).toBe(404);
  });

  it("rejects empty rooms and unknown tracks", async () => {
    const host = await register("+32470000034", "Validation DJ");
    const invalidRoom = await createRoom(
      request("http://localhost/api/sessions", {
        method: "POST",
        token: host.token,
        body: { name: "Empty", tracks: [] },
      }),
    );
    expect(invalidRoom.status).toBe(400);

    const createdResponse = await createRoom(
      request("http://localhost/api/sessions", {
        method: "POST",
        token: host.token,
        body: {
          name: "Valid",
          tracks: [{ title: "Track", artist: "Artist" }],
        },
      }),
    );
    const created = await body<{ session: { id: string } }>(createdResponse);
    const missingVoteState = await vote(
      request(`http://localhost/api/sessions/${created.session.id}/vote`, {
        method: "POST",
        token: host.token,
        body: { trackId: "missing-track" },
      }),
      context(created.session.id),
    );
    expect(missingVoteState.status).toBe(400);
    const missingTrack = await vote(
      request(`http://localhost/api/sessions/${created.session.id}/vote`, {
        method: "POST",
        token: host.token,
        body: { trackId: "missing-track", enabled: true },
      }),
      context(created.session.id),
    );
    expect(missingTrack.status).toBe(404);
  });

  it("claims a browser's free vote when phone onboarding completes", async () => {
    const host = await register("+32470000035", "Anonymous Flow DJ");
    const createdResponse = await createRoom(
      request("http://localhost/api/sessions", {
        method: "POST",
        token: host.token,
        body: {
          name: "Free Vote Room",
          tracks: [
            { title: "First", artist: "Artist A" },
            { title: "Second", artist: "Artist B" },
          ],
        },
      }),
    );
    const created = await body<{
      session: { id: string; tracks: Array<{ id: string }> };
    }>(createdResponse);
    const voterId = "api-browser-voter-000000000001";
    const roomUrl = `http://localhost/api/sessions/${created.session.id}`;

    const freeVote = await vote(
      request(`${roomUrl}/vote`, {
        method: "POST",
        voterId,
        body: { trackId: created.session.tracks[0].id, enabled: true },
      }),
      context(created.session.id),
    );
    expect(freeVote.status).toBe(200);
    expect(
      (await body<{ session: { totalVotes: number } }>(freeVote)).session
        .totalVotes,
    ).toBe(1);

    const anonymousRemoval = await vote(
      request(`${roomUrl}/vote`, {
        method: "POST",
        voterId,
        body: { trackId: created.session.tracks[0].id, enabled: false },
      }),
      context(created.session.id),
    );
    expect(anonymousRemoval.status).toBe(400);

    const retry = await vote(
      request(`${roomUrl}/vote`, {
        method: "POST",
        voterId,
        body: { trackId: created.session.tracks[0].id, enabled: true },
      }),
      context(created.session.id),
    );
    expect(
      (await body<{ session: { totalVotes: number } }>(retry)).session.totalVotes,
    ).toBe(1);

    const blocked = await vote(
      request(`${roomUrl}/vote`, {
        method: "POST",
        voterId,
        body: { trackId: created.session.tracks[1].id, enabled: true },
      }),
      context(created.session.id),
    );
    expect(blocked.status).toBe(403);
    expect(await body(blocked)).toMatchObject({ code: "PHONE_REQUIRED" });
    const accountRequestId = "account-request-0000000000000001";

    const registration = await saveAccount(
      request("http://localhost/api/accounts", {
        method: "POST",
        voterId,
        body: {
          phone: "+32470000036",
          pseudonym: "Phone Guest",
          requestId: accountRequestId,
        },
      }),
    );
    const registered = await body<AccountResponse>(registration);
    const registrationRetry = await saveAccount(
      request("http://localhost/api/accounts", {
        method: "POST",
        voterId,
        body: {
          phone: "+32470000036",
          pseudonym: "Phone Guest",
          requestId: accountRequestId,
        },
      }),
    );
    expect(registrationRetry.status).toBe(200);
    expect((await body<AccountResponse>(registrationRetry)).token).toBe(
      registered.token,
    );
    const permanentRecovery = await saveAccount(
      request("http://localhost/api/accounts", {
        method: "POST",
        voterId,
        body: { phone: "+32470000036", pseudonym: "Takeover" },
      }),
    );
    expect(permanentRecovery.status).toBe(409);

    const claimedAnonymousVote = await vote(
      request(`${roomUrl}/vote`, {
        method: "POST",
        voterId,
        body: { trackId: created.session.tracks[1].id, enabled: true },
      }),
      context(created.session.id),
    );
    expect(claimedAnonymousVote.status).toBe(403);

    const claimedRoom = await getRoom(
      request(roomUrl, { token: registered.token }),
      context(created.session.id),
    );
    const claimed = await body<{
      session: {
        totalVotes: number;
        guestCount: number;
        votedTrackIds: string[];
      };
    }>(claimedRoom);
    expect(claimed.session.totalVotes).toBe(1);
    expect(claimed.session.guestCount).toBe(1);
    expect(claimed.session.votedTrackIds).toEqual([
      created.session.tracks[0].id,
    ]);

    const secondVote = await vote(
      request(`${roomUrl}/vote`, {
        method: "POST",
        token: registered.token,
        body: { trackId: created.session.tracks[1].id, enabled: true },
      }),
      context(created.session.id),
    );
    const afterSecond = await body<{
      session: { totalVotes: number; votedTrackIds: string[] };
    }>(secondVote);
    expect(afterSecond.session.totalVotes).toBe(2);
    expect(afterSecond.session.votedTrackIds).toHaveLength(2);
  });
});

describe("review fixes", () => {
  it("still creates an account on a browser whose voter ID belongs to someone else", async () => {
    const voterId = "shared-phone-voter-0001";
    const first = await saveAccount(
      request("http://localhost/api/accounts", {
        method: "POST",
        voterId,
        body: { phone: "+32470001111", pseudonym: "First" },
      }),
    );
    expect(first.status).toBe(200);

    // A second person on the same passed-around phone. They get an account;
    // they simply have no anonymous vote to carry over.
    const second = await saveAccount(
      request("http://localhost/api/accounts", {
        method: "POST",
        voterId,
        body: { phone: "+32470002222", pseudonym: "Second" },
      }),
    );
    expect(second.status).toBe(200);
    const created = await body<AccountResponse>(second);
    expect(created.account.pseudonym).toBe("Second");

    // Logging in on that browser still refuses to re-link the voter ID.
    const login = await loginAccount(
      request("http://localhost/api/accounts/login", {
        method: "POST",
        voterId,
        body: { phone: "+32470002222" },
      }),
    );
    expect(login.status).toBe(409);
  });

  it("throttles the unauthenticated account routes per address", async () => {
    const attempt = (address: string) =>
      loginAccount(
        request("http://localhost/api/accounts/login", {
          method: "POST",
          headers: { "x-forwarded-for": address },
          body: { phone: "+32470009999" },
        }),
      );
    for (let index = 0; index < 20; index += 1) {
      expect((await attempt("203.0.113.9")).status).toBe(404);
    }
    const limited = await attempt("203.0.113.9");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
    // Another address is unaffected; signup shares the bucket.
    expect((await attempt("203.0.113.10")).status).toBe(404);
    expect(
      (
        await saveAccount(
          request("http://localhost/api/accounts", {
            method: "POST",
            headers: { "x-forwarded-for": "203.0.113.9" },
            body: { phone: "+32470008888", pseudonym: "Late" },
          }),
        )
      ).status,
    ).toBe(429);
  });

  it("treats a blank request ID as no request ID", async () => {
    const host = await register("+32470007777", "Blank Host");
    const open = () =>
      createRoom(
        request("http://localhost/api/sessions", {
          method: "POST",
          token: host.token,
          body: {
            name: "Room",
            venue: "",
            requestId: "",
            tracks: [{ title: "T", artist: "A" }],
          },
        }),
      );
    expect((await open()).status).toBe(201);
    // Before the fix the empty string was stored and the second room hit the
    // per-host unique index.
    expect((await open()).status).toBe(201);
  });
});

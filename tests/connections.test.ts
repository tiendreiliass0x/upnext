import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccount } from "@/lib/accounts";
import {
  completeConnection,
  ConnectionsUnavailableError,
  connectionsUnavailableReason,
  disconnect,
  getAccessToken,
  hasConnection,
  listConnections,
  startConnection,
} from "@/lib/connections";
import { getDatabase } from "@/lib/db";
import {
  ProviderRequestError,
  ReconnectRequiredError,
  type MusicProvider,
} from "@/lib/providers/types";
import { setupTestDatabase } from "./helpers/database";

setupTestDatabase();

const key = Buffer.alloc(32, 3).toString("base64");

/**
 * A stand-in for a real service. The connections layer takes the provider as
 * an argument rather than looking it up by name, so the tests never have to
 * reach the network or stub global fetch.
 */
function fakeProvider(overrides: Partial<MusicProvider> = {}): MusicProvider {
  return {
    id: "soundcloud",
    label: "SoundCloud",
    allowedHosts: ["soundcloud.com"],
    isConfigured: () => true,
    authorizeUrl: ({ redirectUri, state, codeChallenge }) =>
      `https://provider.example/auth?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${codeChallenge}`,
    exchangeCode: vi.fn(async () => ({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresInSeconds: 3600,
      scopes: "read",
    })),
    refresh: vi.fn(async () => ({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresInSeconds: 3600,
      scopes: "read",
    })),
    me: vi.fn(async () => ({
      id: "provider-user",
      displayName: "DJ Owl",
      permalinkUrl: "https://soundcloud.com/djowl",
    })),
    listPlaylists: vi.fn(async () => []),
    listPlaylistTracks: vi.fn(async () => []),
    getTracks: vi.fn(async () => []),
    previewUrl: vi.fn(async () => null),
    ...overrides,
  };
}

function dj(phone = "5551234567") {
  return createAccount({ phone, pseudonym: "DJ Owl" });
}

function stateFrom(authorizeUrl: string) {
  return new URL(authorizeUrl).searchParams.get("state") as string;
}

function storedTokens(accountId: string) {
  return getDatabase()
    .prepare(
      `SELECT access_token, refresh_token, access_expires_at
       FROM provider_connections WHERE account_id = ?`,
    )
    .get(accountId) as {
    access_token: string;
    refresh_token: string | null;
    access_expires_at: string | null;
  };
}

function expireAccessToken(accountId: string) {
  getDatabase()
    .prepare(
      "UPDATE provider_connections SET access_expires_at = ? WHERE account_id = ?",
    )
    .run(new Date(Date.now() - 1000).toISOString(), accountId);
}

beforeEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = key;
  process.env.APP_PUBLIC_URL = "https://upnext.example.com";
});

afterEach(() => {
  delete process.env.TOKEN_ENCRYPTION_KEY;
  delete process.env.APP_PUBLIC_URL;
});

describe("connections", () => {
  it("reports why it cannot run instead of half-working", () => {
    expect(connectionsUnavailableReason(fakeProvider())).toBeNull();

    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(connectionsUnavailableReason(fakeProvider())).toMatch(/store/i);

    process.env.TOKEN_ENCRYPTION_KEY = key;
    delete process.env.APP_PUBLIC_URL;
    expect(connectionsUnavailableReason(fakeProvider())).toMatch(/APP_PUBLIC_URL/);

    process.env.APP_PUBLIC_URL = "https://upnext.example.com";
    expect(
      connectionsUnavailableReason(fakeProvider({ isConfigured: () => false })),
    ).toMatch(/not set up/i);
  });

  it("sends the registered redirect URI, not the address the DJ is on", () => {
    const account = dj();
    const { authorizeUrl } = startConnection({
      accountId: account.id,
      provider: fakeProvider(),
    });
    expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe(
      "https://upnext.example.com/api/connections/soundcloud/callback",
    );
  });

  it("stores the tokens sealed, and never returns them", async () => {
    const account = dj();
    const provider = fakeProvider();
    const { authorizeUrl } = startConnection({ accountId: account.id, provider });
    await completeConnection({
      provider,
      code: "code",
      state: stateFrom(authorizeUrl),
    });

    const stored = storedTokens(account.id);
    expect(stored.access_token).not.toContain("access-1");
    expect(stored.refresh_token).not.toContain("refresh-1");
    expect(stored.access_token.startsWith("v1.")).toBe(true);

    const listed = listConnections(account.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].displayName).toBe("DJ Owl");
    expect(JSON.stringify(listed)).not.toContain("access-1");
    expect(JSON.stringify(listed)).not.toContain("refresh-1");
  });

  it("spends a state value exactly once", async () => {
    const account = dj();
    const provider = fakeProvider();
    const { authorizeUrl } = startConnection({ accountId: account.id, provider });
    const state = stateFrom(authorizeUrl);

    await completeConnection({ provider, code: "code", state });
    // A replayed callback has nothing to bind to and must be refused.
    await expect(
      completeConnection({ provider, code: "code", state }),
    ).rejects.toBeInstanceOf(ConnectionsUnavailableError);
  });

  it("refuses a state that has expired", async () => {
    const account = dj();
    const provider = fakeProvider();
    const { authorizeUrl } = startConnection({ accountId: account.id, provider });
    const state = stateFrom(authorizeUrl);

    getDatabase()
      .prepare("UPDATE oauth_states SET expires_at = ? WHERE state = ?")
      .run(new Date(Date.now() - 1000).toISOString(), state);

    await expect(
      completeConnection({ provider, code: "code", state }),
    ).rejects.toBeInstanceOf(ConnectionsUnavailableError);
  });

  it("replaces a connection rather than duplicating it on reconnect", async () => {
    const account = dj();
    const provider = fakeProvider();
    for (const _ of [0, 1]) {
      const { authorizeUrl } = startConnection({ accountId: account.id, provider });
      await completeConnection({
        provider,
        code: "code",
        state: stateFrom(authorizeUrl),
      });
      void _;
    }
    expect(listConnections(account.id)).toHaveLength(1);
  });

  it("keeps one DJ's connection out of another's list", async () => {
    const owner = dj("5550000001");
    const other = dj("5550000002");
    const provider = fakeProvider();
    const { authorizeUrl } = startConnection({ accountId: owner.id, provider });
    await completeConnection({
      provider,
      code: "code",
      state: stateFrom(authorizeUrl),
    });

    expect(listConnections(other.id)).toHaveLength(0);
    expect(hasConnection(other.id, "soundcloud")).toBe(false);
    await expect(getAccessToken(other.id, provider)).rejects.toBeInstanceOf(
      ReconnectRequiredError,
    );
  });
});

describe("connections: refreshing", () => {
  async function connected(provider: MusicProvider, phone = "5551234567") {
    const account = dj(phone);
    const { authorizeUrl } = startConnection({ accountId: account.id, provider });
    await completeConnection({
      provider,
      code: "code",
      state: stateFrom(authorizeUrl),
    });
    return account;
  }

  it("does not refresh a token that is still good", async () => {
    const provider = fakeProvider();
    const account = await connected(provider);

    expect(await getAccessToken(account.id, provider)).toBe("access-1");
    expect(provider.refresh).not.toHaveBeenCalled();
  });

  it("persists the rotated refresh token, not the spent one", async () => {
    const provider = fakeProvider();
    const account = await connected(provider);
    expireAccessToken(account.id);

    expect(await getAccessToken(account.id, provider)).toBe("access-2");
    expect(provider.refresh).toHaveBeenCalledWith("refresh-1");

    // The next refresh has to present refresh-2. Storing the spent token
    // would sign the DJ out silently the second time round.
    expireAccessToken(account.id);
    await getAccessToken(account.id, provider);
    expect(provider.refresh).toHaveBeenLastCalledWith("refresh-2");
  });

  it("keeps the old refresh token when the provider omits a new one", async () => {
    const provider = fakeProvider({
      refresh: vi.fn(async () => ({
        accessToken: "access-2",
        refreshToken: null,
        expiresInSeconds: 3600,
        scopes: "read",
      })),
    });
    const account = await connected(provider);
    expireAccessToken(account.id);

    await getAccessToken(account.id, provider);
    expireAccessToken(account.id);
    await getAccessToken(account.id, provider);
    expect(provider.refresh).toHaveBeenLastCalledWith("refresh-1");
  });

  it("spends a single-use refresh token only once when two requests race", async () => {
    let inFlight = 0;
    let concurrent = 0;
    const provider = fakeProvider({
      refresh: vi.fn(async (token: string) => {
        inFlight += 1;
        concurrent = Math.max(concurrent, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        // A real provider retires the old token here; a second spend fails.
        if (token !== "refresh-1") throw new Error("invalid_grant");
        return {
          accessToken: "access-2",
          refreshToken: "refresh-2",
          expiresInSeconds: 3600,
          scopes: "read",
        };
      }),
    });
    const account = await connected(provider);
    expireAccessToken(account.id);

    const [first, second] = await Promise.all([
      getAccessToken(account.id, provider),
      getAccessToken(account.id, provider),
    ]);

    expect(concurrent).toBe(1);
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(first).toBe("access-2");
    expect(second).toBe("access-2");
  });

  it("drops the connection when the provider refuses the grant", async () => {
    const provider = fakeProvider({
      refresh: vi.fn(async () => {
        throw new ProviderRequestError(400, "invalid_grant");
      }),
    });
    const account = await connected(provider);
    expireAccessToken(account.id);

    await expect(getAccessToken(account.id, provider)).rejects.toBeInstanceOf(
      ReconnectRequiredError,
    );
    // Gone from the list, so the picker offers Connect instead of retrying a
    // dead token on every request.
    expect(listConnections(account.id)).toHaveLength(0);
  });

  it("keeps the connection when the refresh only failed to get through", async () => {
    // A timeout, a 429 and a 502 are the provider having a bad moment. Deleting
    // a credential over one costs the DJ the whole OAuth dance for a blip.
    const failures = [
      new Error("The connection timed out."),
      new ProviderRequestError(429, "slow down"),
      new ProviderRequestError(503, "unavailable"),
    ];

    for (const [index, failure] of failures.entries()) {
      const provider = fakeProvider({
        refresh: vi.fn(async () => {
          throw failure;
        }),
      });
      const account = await connected(provider, `555000100${index}`);
      expireAccessToken(account.id);

      const thrown = await getAccessToken(account.id, provider).catch((e) => e);
      expect(thrown).not.toBeInstanceOf(ReconnectRequiredError);
      expect(listConnections(account.id)).toHaveLength(1);

      // And the claim was handed back, so the next try is not stuck behind it.
      const provider2 = fakeProvider();
      expect(await getAccessToken(account.id, provider2)).toBe("access-2");
    }
  });

  it("lets a slow refresh finish rather than telling everyone to reconnect", async () => {
    // The provider call can take the http client's whole 8 second deadline.
    // A waiter that gives up first turns one slow trip into a false
    // "reconnect your account" for every other request in the room.
    const provider = fakeProvider({
      refresh: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return {
          accessToken: "access-2",
          refreshToken: "refresh-2",
          expiresInSeconds: 3600,
          scopes: "read",
        };
      }),
    });
    const account = await connected(provider);
    expireAccessToken(account.id);

    const [first, second] = await Promise.all([
      getAccessToken(account.id, provider),
      getAccessToken(account.id, provider),
    ]);
    expect(first).toBe("access-2");
    expect(second).toBe("access-2");
    expect(provider.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale refresh overwrite a reconnected account", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = fakeProvider({
      refresh: vi.fn(async () => {
        await held;
        return {
          accessToken: "stale-access",
          refreshToken: "stale-refresh",
          expiresInSeconds: 3600,
          scopes: "read",
        };
      }),
    });
    const account = await connected(provider);
    expireAccessToken(account.id);

    const inFlight = getAccessToken(account.id, provider);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The DJ reconnects while that refresh is still out. Reconnecting keeps
    // the same row, so the stale write addresses it too.
    const fresh = fakeProvider({
      exchangeCode: vi.fn(async () => ({
        accessToken: "reconnected-access",
        refreshToken: "reconnected-refresh",
        expiresInSeconds: 3600,
        scopes: "read",
      })),
    });
    const { authorizeUrl } = startConnection({ accountId: account.id, provider: fresh });
    await completeConnection({
      provider: fresh,
      code: "code",
      state: stateFrom(authorizeUrl),
    });

    release();
    // The in-flight call notices it lost and returns what the reconnect stored.
    expect(await inFlight).toBe("reconnected-access");
    expect(await getAccessToken(account.id, fresh)).toBe("reconnected-access");
    expect(listConnections(account.id)).toHaveLength(1);
  });

  it("does not let a stale failed refresh delete a reconnected account", async () => {
    let fail: () => void = () => {};
    const held = new Promise<never>((_, reject) => {
      fail = () => reject(new ProviderRequestError(400, "invalid_grant"));
    });
    const provider = fakeProvider({ refresh: vi.fn(async () => held) });
    const account = await connected(provider);
    expireAccessToken(account.id);

    const inFlight = getAccessToken(account.id, provider).catch((e) => e);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const fresh = fakeProvider();
    const { authorizeUrl } = startConnection({ accountId: account.id, provider: fresh });
    await completeConnection({
      provider: fresh,
      code: "code",
      state: stateFrom(authorizeUrl),
    });

    fail();
    await inFlight;
    // The old token really was dead, but the account the DJ just reconnected
    // is not, and must survive.
    expect(listConnections(account.id)).toHaveLength(1);
    expect(await getAccessToken(account.id, fresh)).toBe("access-1");
  });

  it("treats a connection it can no longer open as disconnected", async () => {
    const provider = fakeProvider();
    const account = await connected(provider);

    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
    await expect(getAccessToken(account.id, provider)).rejects.toBeInstanceOf(
      ReconnectRequiredError,
    );
    expect(listConnections(account.id)).toHaveLength(0);
  });

  it("disconnects, and disconnecting twice is not an error", async () => {
    const provider = fakeProvider();
    const account = await connected(provider);

    expect(disconnect(account.id, "soundcloud")).toBe(1);
    expect(disconnect(account.id, "soundcloud")).toBe(0);
    expect(hasConnection(account.id, "soundcloud")).toBe(false);
  });
});

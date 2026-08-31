import { createHash, randomBytes } from "node:crypto";
import { getPublicBaseUrl } from "@/lib/config";
import { getDatabase } from "@/lib/db";
import { getProvider } from "@/lib/providers";
import {
  ProviderRequestError,
  ReconnectRequiredError,
  type MusicProvider,
  type ProviderId,
  type ProviderTokens,
} from "@/lib/providers/types";
import {
  getClientAddress,
  rateLimitedResponse,
  takeRateLimit,
} from "@/lib/rate-limit";
import { openSecret, sealSecret, secretsConfigured } from "@/lib/secrets";

export { ReconnectRequiredError };

/** How long a DJ has between pressing Connect and finishing at the provider. */
const stateLifetimeMs = 10 * 60 * 1000;
/** Refresh this far ahead of expiry so a request in flight does not age out. */
const refreshLeadMs = 60 * 1000;
/** How long one refresh may hold the claim before another may take it over. */
const refreshClaimMs = 20 * 1000;
/**
 * How long a request will wait for somebody else's refresh before giving up.
 * Has to cover a slow-but-successful refresh -- the provider call alone can
 * take the http-client's full 8 second deadline -- or a busy room turns one
 * slow round trip into "reconnect your account" for every other request.
 */
const refreshWaitMs = 250;
const refreshWaitTotalMs = 15 * 1000;

export type PublicConnection = {
  provider: ProviderId;
  label: string;
  displayName: string;
  permalinkUrl: string;
  connectedAt: string;
};

type ConnectionRow = {
  id: string;
  provider: string;
  provider_user_id: string;
  display_name: string;
  permalink_url: string;
  access_token: string;
  refresh_token: string | null;
  access_expires_at: string | null;
  created_at: string;
};

export class ConnectionsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionsUnavailableError";
  }
}

/**
 * The redirect URI has to match what is registered with the provider
 * character for character, so it is derived in exactly one place. It hangs
 * off APP_PUBLIC_URL rather than the request, because the address the DJ
 * happens to be on is frequently a LAN IP (see config.ts) and would never
 * match the registration.
 */
export function redirectUriFor(provider: ProviderId) {
  const base = getPublicBaseUrl();
  return base ? `${base}/api/connections/${provider}/callback` : null;
}

/** Why the feature cannot run here, or null when it can. */
export function connectionsUnavailableReason(provider: MusicProvider) {
  if (!provider.isConfigured()) {
    return `${provider.label} is not set up on this server.`;
  }
  if (!secretsConfigured()) {
    return "This server cannot store connected accounts yet.";
  }
  if (!redirectUriFor(provider.id)) {
    return "Set APP_PUBLIC_URL before connecting an account.";
  }
  return null;
}

function expireOldStates() {
  getDatabase()
    .prepare("DELETE FROM oauth_states WHERE expires_at <= ?")
    .run(new Date().toISOString());
}

function base64url(bytes: Buffer) {
  return bytes.toString("base64url");
}

export function startConnection(input: {
  accountId: string;
  provider: MusicProvider;
}) {
  const reason = connectionsUnavailableReason(input.provider);
  if (reason) throw new ConnectionsUnavailableError(reason);
  const redirectUri = redirectUriFor(input.provider.id) as string;

  expireOldStates();

  const state = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(
    createHash("sha256").update(codeVerifier).digest(),
  );
  const now = Date.now();

  getDatabase()
    .prepare(
      `INSERT INTO oauth_states
        (state, account_id, provider, code_verifier, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      state,
      input.accountId,
      input.provider.id,
      codeVerifier,
      new Date(now).toISOString(),
      new Date(now + stateLifetimeMs).toISOString(),
    );

  return {
    authorizeUrl: input.provider.authorizeUrl({
      redirectUri,
      state,
      codeChallenge,
    }),
  };
}

/**
 * Reads the handshake row and deletes it in the same transaction, so a state
 * value is worth exactly one callback. A replayed callback finds nothing and
 * is refused, which is what makes this the CSRF defence as well as the way
 * the flow remembers whose account it was.
 */
function claimState(state: string, provider: ProviderId) {
  const database = getDatabase();
  return database
    .transaction(() => {
      const row = database
        .prepare(
          `SELECT account_id, code_verifier, expires_at FROM oauth_states
           WHERE state = ? AND provider = ?`,
        )
        .get(state, provider) as
        | { account_id: string; code_verifier: string; expires_at: string }
        | undefined;
      if (!row) return null;
      database.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
      if (row.expires_at <= new Date().toISOString()) return null;
      return row;
    })
    .immediate();
}

function expiresAtFrom(tokens: ProviderTokens) {
  return tokens.expiresInSeconds
    ? new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString()
    : null;
}

export async function completeConnection(input: {
  provider: MusicProvider;
  code: string;
  state: string;
}) {
  const reason = connectionsUnavailableReason(input.provider);
  if (reason) throw new ConnectionsUnavailableError(reason);
  const redirectUri = redirectUriFor(input.provider.id) as string;

  const claimed = claimState(input.state, input.provider.id);
  if (!claimed) {
    throw new ConnectionsUnavailableError(
      "That sign-in link has expired. Try connecting again.",
    );
  }

  const tokens = await input.provider.exchangeCode({
    code: input.code,
    codeVerifier: claimed.code_verifier,
    redirectUri,
  });
  const account = await input.provider.me(tokens.accessToken);
  const now = new Date().toISOString();

  getDatabase()
    .prepare(
      `INSERT INTO provider_connections
        (id, account_id, provider, provider_user_id, display_name,
         permalink_url, scopes, access_token, refresh_token,
         access_expires_at, refreshing_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(account_id, provider) DO UPDATE SET
         provider_user_id = excluded.provider_user_id,
         display_name = excluded.display_name,
         permalink_url = excluded.permalink_url,
         scopes = excluded.scopes,
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         access_expires_at = excluded.access_expires_at,
         refreshing_until = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(
      crypto.randomUUID(),
      claimed.account_id,
      input.provider.id,
      account.id,
      account.displayName,
      account.permalinkUrl,
      tokens.scopes,
      sealSecret(tokens.accessToken),
      tokens.refreshToken ? sealSecret(tokens.refreshToken) : null,
      expiresAtFrom(tokens),
      now,
      now,
    );

  return { accountId: claimed.account_id, displayName: account.displayName };
}

function readConnection(accountId: string, provider: ProviderId) {
  return (
    (getDatabase()
      .prepare(
        `SELECT id, provider, provider_user_id, display_name, permalink_url,
                access_token, refresh_token, access_expires_at, created_at
         FROM provider_connections
         WHERE account_id = ? AND provider = ?`,
      )
      .get(accountId, provider) as ConnectionRow | undefined) ?? null
  );
}

export function listConnections(accountId: string): PublicConnection[] {
  const rows = getDatabase()
    .prepare(
      `SELECT provider, display_name, permalink_url, created_at
       FROM provider_connections WHERE account_id = ?
       ORDER BY created_at ASC`,
    )
    .all(accountId) as Array<{
    provider: string;
    display_name: string;
    permalink_url: string;
    created_at: string;
  }>;

  // Tokens are deliberately not selected here. Nothing about a connection
  // that leaves the server should be able to act on the DJ's behalf, the same
  // rule sessions.ts applies to account and voter IDs.
  return rows.flatMap((row) => {
    const provider = getProvider(row.provider);
    if (!provider) return [];
    return [
      {
        provider: provider.id,
        label: provider.label,
        displayName: row.display_name,
        permalinkUrl: row.permalink_url,
        connectedAt: row.created_at,
      },
    ];
  });
}

export function disconnect(accountId: string, provider: ProviderId) {
  return getDatabase()
    .prepare(
      "DELETE FROM provider_connections WHERE account_id = ? AND provider = ?",
    )
    .run(accountId, provider).changes;
}

/**
 * Drop a connection, unless it has been replaced since we read it. Same
 * compare-and-swap as storeRefreshed, and for the same reason: a stale
 * refresh failing must not delete an account the DJ has just reconnected.
 */
function forgetIfUnchanged(row: ConnectionRow) {
  getDatabase()
    .prepare(
      "DELETE FROM provider_connections WHERE id = ? AND access_token = ?",
    )
    .run(row.id, row.access_token);
}

/**
 * Take the right to refresh this connection.
 *
 * The refresh token is single use: the provider hands back a new one and
 * invalidates the old. Two requests refreshing at once would both spend the
 * same token, the loser would store a token the provider has already retired,
 * and the DJ would be silently signed out mid-set. Only one holder at a time
 * gets to do it; the claim ages out so a crashed request cannot wedge it.
 */
function claimRefresh(connectionId: string) {
  const now = new Date();
  return (
    getDatabase()
      .prepare(
        `UPDATE provider_connections
            SET refreshing_until = ?
          WHERE id = ?
            AND (refreshing_until IS NULL OR refreshing_until <= ?)`,
      )
      .run(
        new Date(now.getTime() + refreshClaimMs).toISOString(),
        connectionId,
        now.toISOString(),
      ).changes > 0
  );
}

/**
 * Write the refreshed tokens, but only if the row still holds the ones we
 * read. False means it does not, and the caller must start over.
 *
 * Reconnecting keeps the existing row (the upsert conflicts on
 * account_id + provider), so a refresh that started before a reconnect and
 * finished after it addresses the same id and would otherwise overwrite the
 * brand new tokens with older ones. Sealing uses a fresh nonce every time, so
 * the stored ciphertext is unique to one write and makes a natural
 * compare-and-swap without another column.
 */
function storeRefreshed(
  row: ConnectionRow,
  tokens: ProviderTokens,
  previousRefreshToken: string,
) {
  return (
    getDatabase()
      .prepare(
        `UPDATE provider_connections
            SET access_token = ?, refresh_token = ?, access_expires_at = ?,
                scopes = ?, refreshing_until = NULL, updated_at = ?
          WHERE id = ? AND access_token = ?`,
      )
      .run(
        sealSecret(tokens.accessToken),
        // Spotify-style providers may omit it; SoundCloud always rotates. Keep
        // whichever token is still the live one.
        sealSecret(tokens.refreshToken ?? previousRefreshToken),
        expiresAtFrom(tokens),
        tokens.scopes,
        new Date().toISOString(),
        row.id,
        row.access_token,
      ).changes > 0
  );
}

/** Give the claim back so a transient failure does not hold it for 20s. */
function releaseRefreshClaim(row: ConnectionRow) {
  getDatabase()
    .prepare(
      `UPDATE provider_connections SET refreshing_until = NULL
        WHERE id = ? AND access_token = ?`,
    )
    .run(row.id, row.access_token);
}

/**
 * Whether a failed refresh means the grant is gone, or only that the trip
 * failed.
 *
 * This is the difference between asking the DJ to sign in again and quietly
 * retrying: deleting a credential because SoundCloud returned a 503, or
 * because the venue's wifi dropped a packet, costs them the whole OAuth dance
 * for a blip. Only the provider actually refusing the grant is terminal.
 */
function isTerminalAuthError(error: unknown) {
  if (!(error instanceof ProviderRequestError)) return false;
  // Rate limiting and server errors are the provider having a bad moment.
  if (error.status === 429 || error.status >= 500) return false;
  // A 4xx from the token endpoint is invalid_grant territory: revoked in the
  // provider's settings, or a rotated refresh token already spent.
  return error.status >= 400;
}

function needsRefresh(row: ConnectionRow) {
  if (!row.access_expires_at) return false;
  return Date.parse(row.access_expires_at) - Date.now() <= refreshLeadMs;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The live access token for this DJ's connection, refreshing it if needed.
 *
 * Throws ReconnectRequiredError only when the grant is genuinely gone, so a
 * 409 from a route means "sign in again" and nothing else does. Anything the
 * provider might recover from is thrown as an ordinary error, which the routes
 * answer as a 502.
 */
export async function getAccessToken(
  accountId: string,
  provider: MusicProvider,
): Promise<string> {
  const waitUntil = Date.now() + refreshWaitTotalMs;

  for (;;) {
    const row = readConnection(accountId, provider.id);
    if (!row) throw new ReconnectRequiredError(provider.id);

    const accessToken = openSecret(row.access_token);
    // Unreadable means the key rotated or the row was tampered with. Either
    // way this is not a connection any more; say so rather than 500.
    if (!accessToken) {
      forgetIfUnchanged(row);
      throw new ReconnectRequiredError(provider.id);
    }
    if (!needsRefresh(row)) return accessToken;

    const refreshToken = openSecret(row.refresh_token);
    if (!refreshToken) {
      forgetIfUnchanged(row);
      throw new ReconnectRequiredError(provider.id);
    }

    if (!claimRefresh(row.id)) {
      // Somebody else is refreshing. Wait for them rather than spending a
      // single-use token twice, then re-read what they stored. The budget has
      // to outlast a slow provider: giving up early would turn one slow round
      // trip into a false "reconnect your account" for every other request.
      if (Date.now() >= waitUntil) {
        throw new Error(`${provider.label} is taking too long to answer.`);
      }
      await sleep(refreshWaitMs);
      continue;
    }

    let tokens: ProviderTokens;
    try {
      tokens = await provider.refresh(refreshToken);
    } catch (error) {
      releaseRefreshClaim(row);
      if (isTerminalAuthError(error)) {
        // The grant is gone: revoked, or a rotated token already spent. Drop
        // the row so the UI offers Connect instead of retrying a dead token.
        forgetIfUnchanged(row);
        throw new ReconnectRequiredError(provider.id);
      }
      // A timeout, a 429, a 5xx. The credential is still good; only this trip
      // failed, and deleting it would cost the DJ the whole OAuth dance.
      throw error;
    }

    // False means the DJ reconnected while this was in flight, and the row now
    // holds newer tokens than the ones just minted. Start over and use theirs.
    if (storeRefreshed(row, tokens, refreshToken)) return tokens.accessToken;
    if (Date.now() >= waitUntil) {
      throw new Error(`${provider.label} is taking too long to answer.`);
    }
  }
}

/** Whether the DJ has this provider connected, without touching the network. */
export function hasConnection(accountId: string, provider: ProviderId) {
  return readConnection(accountId, provider) !== null;
}

/**
 * Every provider call spends the allowance the whole deployment shares, so it
 * is counted per account first: one DJ leaning on the picker must not be able
 * to exhaust it for everyone. The address is counted too, because an account
 * here costs only an unverified phone number.
 */
export const providerRateLimit = { limit: 60, windowMs: 15 * 60 * 1000 };

export function guardProviderRequest(request: Request, accountId: string) {
  const retryAfter =
    takeRateLimit("connections", accountId, providerRateLimit) ??
    takeRateLimit("connections-ip", getClientAddress(request), providerRateLimit);
  return retryAfter === null ? null : rateLimitedResponse(retryAfter);
}

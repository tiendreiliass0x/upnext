/**
 * The shape a music service has to present to the rest of the app.
 *
 * Only SoundCloud implements this today (see the plan's note on why Spotify
 * does not). The interface exists so the routes, the session import and the
 * picker never name a provider, not as speculative generality: the day a
 * second one is viable it should be a file, not a refactor.
 */

export type ProviderId = "soundcloud";

/**
 * Kept here rather than on the adapter so a client component can name a
 * service without pulling the whole adapter, and its secrets handling, into
 * the browser bundle.
 */
export const providerLabels: Record<ProviderId, string> = {
  soundcloud: "SoundCloud",
};

export type ProviderTokens = {
  accessToken: string;
  /** Absent when the provider did not return a new one; keep the old one. */
  refreshToken: string | null;
  expiresInSeconds: number | null;
  scopes: string;
};

export type ProviderAccount = {
  id: string;
  displayName: string;
  permalinkUrl: string;
};

export type ProviderPlaylist = {
  id: string;
  title: string;
  trackCount: number | null;
  artworkUrl: string | null;
};

/**
 * `access` decides whether a row can carry audio at all:
 * playable and preview both give a preview clip, blocked gives nothing.
 */
export type ProviderTrackAccess = "playable" | "preview" | "blocked";

export type ProviderTrack = {
  providerTrackId: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
  durationMs: number | null;
  /** Required by the provider's terms wherever the track is displayed. */
  permalinkUrl: string;
  uploaderName: string;
  access: ProviderTrackAccess;
};

export class ReconnectRequiredError extends Error {
  readonly provider: ProviderId;
  constructor(provider: ProviderId) {
    super("Reconnect this account to keep using it.");
    this.name = "ReconnectRequiredError";
    this.provider = provider;
  }
}

export class ProviderRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProviderRequestError";
    this.status = status;
  }
}

export type MusicProvider = {
  id: ProviderId;
  label: string;
  /** False when this deployment has no client credentials for it. */
  isConfigured(): boolean;
  authorizeUrl(input: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
  }): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<ProviderTokens>;
  refresh(refreshToken: string): Promise<ProviderTokens>;
  me(accessToken: string): Promise<ProviderAccount>;
  listPlaylists(accessToken: string): Promise<ProviderPlaylist[]>;
  listPlaylistTracks(
    accessToken: string,
    playlistId: string,
    options?: { query?: string; limit?: number },
  ): Promise<ProviderTrack[]>;
  getTracks(accessToken: string, ids: string[]): Promise<ProviderTrack[]>;
  /** A short clip URL an <audio> element can play, or null. */
  previewUrl(accessToken: string, providerTrackId: string): Promise<string | null>;
  /** Hosts this provider is allowed to hand us URLs on. */
  allowedHosts: readonly string[];
};

import { getAccessToken, hasConnection } from "@/lib/connections";
import { getProvider } from "@/lib/providers";
import { getTrackProviderRef } from "@/lib/sessions";

/**
 * Resolving an imported row's clip, with a short memory.
 *
 * The preview route is deliberately unauthenticated — being a track in a live
 * room is the gate — so every phone in the room can ask for the same song at
 * the same moment. Each of those would otherwise be a call against the host
 * DJ's connection, and SoundCloud counts stream access against a daily
 * ceiling. Cached, a full room costs one call per song instead of one per
 * listener.
 *
 * Only the URL is held, never audio: the provider's terms forbid caching or
 * persisting the content itself. The TTL is well inside how long these URLs
 * stay good, and the whole thing is in memory, so a restart simply re-asks.
 */
const successTtlMs = 10 * 60 * 1000;
// A track with no clip is a stable fact for a while, but not forever: a
// disconnected DJ who reconnects should not wait ten minutes for audio.
const emptyTtlMs = 60 * 1000;

type Entry = { url: string | null; expiresAt: number };

type PreviewCacheRegistry = typeof globalThis & {
  upnextProviderPreviews?: Map<string, Entry>;
};

const registry = globalThis as PreviewCacheRegistry;
const cache = registry.upnextProviderPreviews ?? new Map<string, Entry>();
registry.upnextProviderPreviews = cache;

function readCache(trackId: string, now: number) {
  const entry = cache.get(trackId);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    cache.delete(trackId);
    return undefined;
  }
  return entry;
}

function writeCache(trackId: string, url: string | null, now: number) {
  // Sweep on write rather than on a timer, the way rate-limit.ts does: a room
  // that has ended should not hold its rows here until the process restarts.
  if (cache.size > 5_000) {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
  }
  cache.set(trackId, {
    url,
    expiresAt: now + (url ? successTtlMs : emptyTtlMs),
  });
}

/**
 * A URL an <audio> element can play for an imported row, or null when there
 * is nothing to play. Never throws: a provider that is down, a DJ who
 * disconnected mid-set, and a track with no clip all mean the same thing to
 * the room, which is that this row shows as having no audio.
 */
export async function resolveProviderPreviewUrl(trackId: string) {
  const now = Date.now();

  // The gate is checked before the cache, never after. Being a track in a
  // live room is the whole permission here, and a cached URL served past the
  // end of the room -- or after the DJ disconnected the account -- would keep
  // handing out the provider's audio for as long as the entry lived. The
  // cache exists to save a provider round trip, not a local SQLite read.
  const reference = getTrackProviderRef(trackId);
  if (!reference) return null;

  const provider = getProvider(reference.provider);
  if (!provider) return null;

  // The DJ's grant is what lets this app hand out the provider's audio, so a
  // disconnected account stops the row immediately -- including one already
  // in the cache. Otherwise disconnecting would take effect ten minutes late
  // for every song the room had already played.
  if (!hasConnection(reference.hostAccountId, provider.id)) return null;

  const cached = readCache(trackId, now);
  if (cached) return cached.url;

  try {
    const accessToken = await getAccessToken(reference.hostAccountId, provider);
    const url = await provider.previewUrl(
      accessToken,
      reference.providerTrackId,
    );
    writeCache(trackId, url, now);
    return url;
  } catch {
    writeCache(trackId, null, now);
    return null;
  }
}

export function clearProviderPreviewCache() {
  cache.clear();
}

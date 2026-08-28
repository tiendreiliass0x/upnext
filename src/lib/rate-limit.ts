/**
 * A small fixed-window limiter for the unauthenticated account routes.
 *
 * Phone login is deliberately unverified (see admin.ts), which sets the bar at
 * "anyone who knows a registered number holds that account". Without a limit
 * that bar collapses: the login route answers 404 for unknown numbers and 200
 * with a bearer token for known ones, so a prefix sweep would harvest every
 * DJ account on the box. Throttling per address keeps the bar where the
 * design put it. State is per process, which is the whole deployment.
 */

type Bucket = { count: number; resetAt: number };

type RateLimitRegistry = typeof globalThis & {
  upnextRateLimits?: Map<string, Bucket>;
};

const registry = globalThis as RateLimitRegistry;
const buckets = registry.upnextRateLimits ?? new Map<string, Bucket>();
registry.upnextRateLimits = buckets;

export const accountRateLimit = {
  // Enough for a table of friends signing up behind one NAT; far too few to
  // enumerate a mobile prefix.
  limit: 20,
  windowMs: 15 * 60 * 1000,
};

export function getClientAddress(request: Request) {
  // Caddy sets X-Forwarded-For to the connecting address; the last hop is
  // the one it saw, earlier ones are whatever the client claimed.
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Returns the seconds until the window resets when the caller is over the
 * limit, or null when the request may proceed (and has been counted).
 */
export function takeRateLimit(
  scope: string,
  key: string,
  options: { limit: number; windowMs: number } = accountRateLimit,
  now = Date.now(),
): number | null {
  const bucketKey = `${scope}:${key}`;
  const bucket = buckets.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) {
    // Sweep expired buckets so an address seen once is not kept forever.
    if (buckets.size > 10_000) {
      for (const [candidate, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(candidate);
      }
    }
    buckets.set(bucketKey, { count: 1, resetAt: now + options.windowMs });
    return null;
  }
  if (bucket.count >= options.limit) {
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  }
  bucket.count += 1;
  return null;
}

export function rateLimitedResponse(retryAfterSeconds: number) {
  return Response.json(
    { error: "Too many attempts. Try again in a few minutes." },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    },
  );
}

export function resetRateLimits() {
  buckets.clear();
}

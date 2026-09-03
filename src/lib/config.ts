/**
 * The origin guests will actually use to reach this app.
 *
 * Guest links are otherwise derived from whatever address the DJ happened to
 * open the booth on. That address is frequently a private one — a LAN IP that
 * only resolves on the venue's own wifi, or localhost, which resolves to the
 * guest's own phone — and the QR code renders happily either way.
 */
export function getPublicBaseUrl() {
  const configured = process.env.APP_PUBLIC_URL?.trim();
  if (!configured) return null;

  try {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // A base URL carrying a query or fragment would survive into every guest
    // link, so keep only the part that addresses the app.
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export type GuestOriginReach = "public" | "private" | "loopback" | "unknown";

/**
 * Whether a guest who is not on the DJ's network could load this address.
 * Deliberately three-valued: a LAN address is wrong for guests on cellular but
 * genuinely correct for a venue where everyone joins the house wifi, so it is
 * worth a warning rather than a refusal. Loopback is never reachable by anyone.
 */
export function classifyGuestOrigin(value: string): GuestOriginReach {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "unknown";
  }

  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (host === "::1" || host === "0.0.0.0" || host === "::") return "loopback";
  if (/^127\./.test(host)) return "loopback";

  // mDNS names only resolve on the local link.
  if (host.endsWith(".local")) return "private";
  // RFC 1918 and the link-local range.
  if (/^10\./.test(host)) return "private";
  if (/^192\.168\./.test(host)) return "private";
  if (/^169\.254\./.test(host)) return "private";
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return "private";
  // Unique local IPv6.
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return "private";

  return "public";
}

/**
 * How long a room stays reachable when the DJ has not asked to hold it open.
 *
 * The setup screen promises this number to the DJ and the room is stamped with
 * it at creation, so both read it here rather than each writing out a day in
 * their own units.
 */
export const sessionLifetimeHours = 24;
export const sessionLifetimeMs = sessionLifetimeHours * 60 * 60 * 1000;

/**
 * How many songs one room holds. The setup screen stops the draft here and the
 * launch route stops again on what it is sent, so the number belongs to both.
 */
export const maximumDraftTracks = 200;

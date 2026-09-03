/**
 * The rules a profile has to satisfy and the names its picture is stored
 * under. Deliberately free of any database import: the booth is a client
 * component and asks the same questions of the same strings the routes do, so
 * anything it shares with the server has to be reachable from the browser
 * bundle. Pulling these out of accounts.ts is what keeps better-sqlite3 from
 * being dragged in behind them.
 */

export const pseudonymLimits = { minimum: 2, maximum: 24 };
export const taglineLimit = 120;

/**
 * What is wrong with a username as typed, or null if nothing is. Exported so
 * the profile form and the route that saves it ask the same question of the
 * same string: a looser form would offer a Save that always fails, and a
 * stricter one would refuse a name the server would have taken.
 */
export function pseudonymError(value: string): string | null {
  const trimmed = value.trim();
  if (
    trimmed.length < pseudonymLimits.minimum ||
    trimmed.length > pseudonymLimits.maximum
  ) {
    return `Choose a username between ${pseudonymLimits.minimum} and ${pseudonymLimits.maximum} characters.`;
  }
  // The name is rendered as text everywhere, but a newline inside it would
  // break the one-line places it appears (the room header, a row's faces).
  if (/[\r\n\t]/.test(trimmed)) {
    return "A username has to fit on one line.";
  }
  return null;
}

/** The same for the line under the name; blank is allowed, it is optional. */
export function taglineError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length > taglineLimit) {
    return `Keep your tagline under ${taglineLimit} characters.`;
  }
  if (/[\r\n]/.test(trimmed)) return "A tagline has to fit on one line.";
  return null;
}

/**
 * Profile pictures live at `avatars/<random>.<ext>` and are addressed by that
 * name alone, with no account ID in the path: the room shows a face beside
 * every vote, and an account ID next to each one would hand every guest a
 * stable identifier for everybody else in the venue. The random name is the
 * capability, and because a new picture gets a new name, the URL changes when
 * the picture does — which is what makes it safe to cache one hard.
 */
export const avatarKeyPrefix = "avatars/";
const avatarNamePattern = /^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/;

export function avatarObjectKey(extension: string) {
  return `${avatarKeyPrefix}${crypto.randomUUID()}.${extension}`;
}

export function avatarUrlFor(objectKey: string | null) {
  if (!objectKey) return null;
  return `/api/avatars/${objectKey.slice(avatarKeyPrefix.length)}`;
}

/** The object key a request for `name` addresses, or null if none can. */
export function avatarKeyForName(name: string) {
  return avatarNamePattern.test(name) ? `${avatarKeyPrefix}${name}` : null;
}

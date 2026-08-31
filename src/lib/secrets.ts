import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Sealing for third-party credentials at rest.
 *
 * Everything else in this database is either public (a room, a ballot) or a
 * capability this app issued and can revoke by deleting the row (an auth
 * token, a host key). A provider refresh token is neither: it is a standing
 * grant against someone else's account, it outlives any row here, and
 * data/dj-booth.sqlite is a plain file that sits in the working tree in dev.
 * So it is encrypted with a key that lives outside the file it protects.
 *
 * AES-256-GCM rather than plain CBC/CTR so a tampered row fails to open
 * instead of decrypting to garbage that a caller might then send to a
 * provider. The version prefix is there so the scheme can be rolled without
 * guessing at the format of what is already stored.
 */

const version = "v1";
const ivLength = 12; // GCM's standard nonce size.
const keyLength = 32;

export class SecretsUnavailableError extends Error {
  constructor() {
    super("Connected accounts are not configured on this server.");
    this.name = "SecretsUnavailableError";
  }
}

function readKey() {
  const configured = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (!configured) return null;

  let key: Buffer;
  try {
    key = Buffer.from(configured, "base64");
  } catch {
    return null;
  }
  // A short key would still "work" in the sense that Node would refuse it
  // loudly at cipher time; catching it here means the feature reports itself
  // unavailable up front rather than failing on the DJ's first connect.
  return key.length === keyLength ? key : null;
}

/**
 * Whether this server can hold connected accounts at all.
 *
 * Mirrors isAdminConfigured: with no key set the feature does not exist,
 * rather than existing in a state where tokens land in the clear.
 */
export function secretsConfigured() {
  return readKey() !== null;
}

export function sealSecret(plain: string) {
  const key = readKey();
  if (!key) throw new SecretsUnavailableError();

  const iv = randomBytes(ivLength);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  return [
    version,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Returns null rather than throwing when the value cannot be opened.
 *
 * A rotated key, a restored backup, or a tampered row all land here, and the
 * honest reading of every one of them is "this connection is gone" — which
 * the DJ fixes by connecting again. Throwing would turn a recoverable state
 * into a 500 on a page that could have shown a Connect button.
 */
export function openSecret(sealed: string | null | undefined) {
  const key = readKey();
  if (!key || !sealed) return null;

  const parts = sealed.split(".");
  if (parts.length !== 4) return null;

  const [presentedVersion, rawIv, rawTag, rawCiphertext] = parts;
  const expected = Buffer.from(version);
  const presented = Buffer.from(presentedVersion);
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  ) {
    return null;
  }

  try {
    const iv = Buffer.from(rawIv, "base64url");
    const tag = Buffer.from(rawTag, "base64url");
    if (iv.length !== ivLength || tag.length !== 16) return null;

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(rawCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // final() throws when the tag does not match: the row is not ours.
    return null;
  }
}

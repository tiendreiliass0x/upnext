import { afterEach, describe, expect, it } from "vitest";
import { openSecret, sealSecret, secretsConfigured } from "@/lib/secrets";

const key = Buffer.alloc(32, 7).toString("base64");
const otherKey = Buffer.alloc(32, 9).toString("base64");

afterEach(() => {
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

describe("secrets", () => {
  it("reports itself unconfigured without a usable key", () => {
    expect(secretsConfigured()).toBe(false);

    process.env.TOKEN_ENCRYPTION_KEY = "not-base64-32-bytes";
    expect(secretsConfigured()).toBe(false);

    // Right encoding, wrong length: still refused up front rather than at the
    // first connect.
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(secretsConfigured()).toBe(false);

    process.env.TOKEN_ENCRYPTION_KEY = key;
    expect(secretsConfigured()).toBe(true);
  });

  it("round trips a token and never stores it in the clear", () => {
    process.env.TOKEN_ENCRYPTION_KEY = key;
    const token = "oauth-refresh-token-value";
    const sealed = sealSecret(token);

    expect(sealed).not.toContain(token);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(openSecret(sealed)).toBe(token);
  });

  it("uses a fresh nonce, so the same token seals differently each time", () => {
    process.env.TOKEN_ENCRYPTION_KEY = key;
    expect(sealSecret("same")).not.toBe(sealSecret("same"));
  });

  it("refuses a tampered value rather than returning garbage", () => {
    process.env.TOKEN_ENCRYPTION_KEY = key;
    const [version, iv, tag, ciphertext] = sealSecret("token").split(".");

    expect(openSecret(`${version}.${iv}.${tag}.${ciphertext}AAAA`)).toBeNull();
    expect(openSecret(`${version}.${iv}.AAAAAAAAAAAAAAAAAAAAAA.${ciphertext}`)).toBeNull();
    expect(openSecret(`v2.${iv}.${tag}.${ciphertext}`)).toBeNull();
    expect(openSecret("nonsense")).toBeNull();
    expect(openSecret(null)).toBeNull();
  });

  it("reads a rotated key as 'not connected' rather than throwing", () => {
    process.env.TOKEN_ENCRYPTION_KEY = key;
    const sealed = sealSecret("token");

    process.env.TOKEN_ENCRYPTION_KEY = otherKey;
    // The caller's job is to offer Connect again; it must not have to catch.
    expect(openSecret(sealed)).toBeNull();
  });

  it("throws when asked to seal with no key, so nothing lands in the clear", () => {
    expect(() => sealSecret("token")).toThrow();
  });
});

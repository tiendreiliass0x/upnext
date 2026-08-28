import { afterEach, describe, expect, it } from "vitest";
import { classifyGuestOrigin, getPublicBaseUrl } from "@/lib/config";

const original = process.env.APP_PUBLIC_URL;
afterEach(() => {
  if (original === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = original;
});

function withUrl(value: string | undefined) {
  if (value === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = value;
  return getPublicBaseUrl();
}

describe("public base URL", () => {
  it("is null when unset or blank", () => {
    expect(withUrl(undefined)).toBeNull();
    expect(withUrl("   ")).toBeNull();
  });

  it("keeps scheme, host, port and path", () => {
    expect(withUrl("https://upnext.example.com")).toBe("https://upnext.example.com");
    expect(withUrl("http://192.0.2.10:3000")).toBe("http://192.0.2.10:3000");
    expect(withUrl("https://example.com/booth")).toBe("https://example.com/booth");
  });

  it("drops a trailing slash so links do not double up", () => {
    expect(withUrl("https://example.com/")).toBe("https://example.com");
    expect(withUrl("https://example.com/booth//")).toBe("https://example.com/booth");
  });

  it("strips a query or fragment that would survive into every guest link", () => {
    expect(withUrl("https://example.com/?utm=1#top")).toBe("https://example.com");
  });

  it("rejects anything that is not an absolute http(s) URL", () => {
    expect(withUrl("upnext.example.com")).toBeNull();
    expect(withUrl("ftp://example.com")).toBeNull();
    expect(withUrl("javascript:alert(1)")).toBeNull();
    expect(withUrl("not a url")).toBeNull();
  });
});

describe("guest origin reachability", () => {
  it("treats loopback as reachable by nobody", () => {
    for (const value of [
      "http://localhost:3000/?session=AB12CD",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
      "http://0.0.0.0:3000",
    ]) {
      expect(classifyGuestOrigin(value)).toBe("loopback");
    }
  });

  it("treats every private range as same-network only", () => {
    for (const value of [
      "http://10.0.0.117:3000/?session=LTEMG8",
      "http://192.168.1.20:3000",
      "http://172.16.4.4:3000",
      "http://172.31.255.1:3000",
      "http://169.254.10.1:3000",
      "http://studio.local:3000",
      "http://[fd00::1]:3000",
    ]) {
      expect(classifyGuestOrigin(value)).toBe("private");
    }
  });

  it("does not mistake public addresses that merely look close", () => {
    for (const value of [
      "https://upnext.example.com/?session=LTEMG8",
      "http://172.15.0.1:3000",
      "http://172.32.0.1:3000",
      "http://11.0.0.1:3000",
      "http://192.169.0.1:3000",
    ]) {
      expect(classifyGuestOrigin(value)).toBe("public");
    }
  });

  it("reports unknown rather than guessing on junk", () => {
    expect(classifyGuestOrigin("")).toBe("unknown");
    expect(classifyGuestOrigin("nonsense")).toBe("unknown");
  });
});

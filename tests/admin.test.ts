import { afterEach, describe, expect, it } from "vitest";
import { adminTokenHeader, isAdminConfigured, isAdminRequest } from "@/lib/admin";

const original = process.env.ADMIN_TOKEN;
afterEach(() => {
  if (original === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = original;
});

function req(token?: string) {
  return new Request("http://localhost/api/libraries", {
    headers: token === undefined ? {} : { [adminTokenHeader]: token },
  });
}

describe("admin token", () => {
  it("treats an unset token as no admin surface, not an open one", () => {
    delete process.env.ADMIN_TOKEN;
    expect(isAdminConfigured()).toBe(false);
    expect(isAdminRequest(req("anything"))).toBe(false);
    // The dangerous failure would be an empty header matching an empty secret.
    expect(isAdminRequest(req(""))).toBe(false);
    expect(isAdminRequest(req())).toBe(false);
  });

  it("treats a blank configured token as unset", () => {
    process.env.ADMIN_TOKEN = "   ";
    expect(isAdminConfigured()).toBe(false);
    expect(isAdminRequest(req("   "))).toBe(false);
  });

  it("accepts only the exact secret", () => {
    process.env.ADMIN_TOKEN = "super-secret-admin-token";
    expect(isAdminRequest(req("super-secret-admin-token"))).toBe(true);
    expect(isAdminRequest(req("super-secret-admin-toke"))).toBe(false);
    expect(isAdminRequest(req("super-secret-admin-tokenX"))).toBe(false);
    expect(isAdminRequest(req("SUPER-SECRET-ADMIN-TOKEN"))).toBe(false);
    expect(isAdminRequest(req())).toBe(false);
  });

  it("does not throw on a length mismatch", () => {
    process.env.ADMIN_TOKEN = "short";
    expect(() => isAdminRequest(req("a-much-longer-presented-token"))).not.toThrow();
    expect(isAdminRequest(req("a-much-longer-presented-token"))).toBe(false);
  });
});

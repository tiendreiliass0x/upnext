import { describe, expect, it } from "vitest";
import {
  createAccount,
  getAccountByPhone,
  getAccountByToken,
  normalizePhone,
  toPublicAccount,
  updateAccountPseudonym,
} from "@/lib/accounts";
import { getAccountFromRequest } from "@/lib/auth";
import { setupTestDatabase } from "./helpers/database";

setupTestDatabase();

describe("accounts", () => {
  it("normalizes international phone formats", () => {
    expect(normalizePhone("+32 470 12 34 56")).toBe("+32470123456");
    expect(normalizePhone("0032 470 12 34 56")).toBe("+32470123456");
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("+1234567890123456")).toBeNull();
  });

  it("persists an account and keeps its token private from public data", () => {
    const account = createAccount({
      phone: "+32470123456",
      pseudonym: "Night Owl",
    });

    expect(getAccountByPhone(account.phone)).toEqual(account);
    expect(getAccountByToken(account.authToken)).toEqual(account);
    expect(toPublicAccount(account)).toEqual({
      id: account.id,
      pseudonym: "Night Owl",
      phoneLast4: "3456",
    });
    expect(toPublicAccount(account)).not.toHaveProperty("authToken");
    expect(toPublicAccount(account)).not.toHaveProperty("phone");
  });

  it("updates a pseudonym without rotating the account token", () => {
    const account = createAccount({
      phone: "+32470987654",
      pseudonym: "Old Name",
    });
    const updated = updateAccountPseudonym(account, "Mint Fox");

    expect(updated.authToken).toBe(account.authToken);
    expect(getAccountByToken(account.authToken)?.pseudonym).toBe("Mint Fox");
  });

  it("resolves bearer and fallback account headers", () => {
    const account = createAccount({
      phone: "+32470000001",
      pseudonym: "Header Test",
    });

    expect(
      getAccountFromRequest(
        new Request("http://localhost", {
          headers: { Authorization: `Bearer ${account.authToken}` },
        }),
      )?.id,
    ).toBe(account.id);
    expect(
      getAccountFromRequest(
        new Request("http://localhost", {
          headers: { "x-upnext-account-token": account.authToken },
        }),
      )?.id,
    ).toBe(account.id);
    expect(getAccountFromRequest(new Request("http://localhost"))).toBeNull();
  });
});

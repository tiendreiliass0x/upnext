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
import { createSession, getSession, toggleVote } from "@/lib/sessions";
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

describe("renaming while in a room", () => {
  it("refreshes the station name in rooms the account hosts", () => {
    const host = createAccount({ phone: "+32470005000", pseudonym: "Old DJ" });
    const created = createSession({
      name: "Set",
      venue: "",
      accountId: host.id,
      requestId: crypto.randomUUID(),
      tracks: [{ title: "T", artist: "A" }],
    });
    const before = getSession(created.session.id)!;

    updateAccountPseudonym(host, "New DJ");

    const after = getSession(created.session.id)!;
    expect(after.djName).toBe("New DJ");
    expect(after.revision).toBe(before.revision + 1);
  });

  it("bumps the revision of every live room the account has voted in, so guests see the new name", () => {
    const host = createAccount({ phone: "+32470005001", pseudonym: "Host" });
    const fan = createAccount({ phone: "+32470005002", pseudonym: "Old Name" });
    const bystander = createAccount({ phone: "+32470005003", pseudonym: "Host Two" });
    const rooms = [host, bystander].map((owner) =>
      createSession({
        name: "Set",
        venue: "",
        accountId: owner.id,
        requestId: crypto.randomUUID(),
        tracks: [{ title: "T", artist: "A" }],
      }),
    );
    const [votedIn, notVotedIn] = rooms;
    toggleVote({
      sessionId: votedIn.session.id,
      trackId: getSession(votedIn.session.id)!.tracks[0].id,
      accountId: fan.id,
      enabled: true,
    });
    const before = getSession(votedIn.session.id)!;
    const untouchedBefore = getSession(notVotedIn.session.id)!.revision;
    expect(before.tracks[0].voters).toEqual([{ name: "Old Name" }]);

    updateAccountPseudonym(fan, "New Name");

    const after = getSession(votedIn.session.id)!;
    // A guest polling with the old ETag now gets a body instead of a 304.
    expect(after.revision).toBe(before.revision + 1);
    expect(after.tracks[0].voters).toEqual([{ name: "New Name" }]);
    expect(after.voters).toEqual([{ name: "New Name" }]);
    // Rooms the account never voted in are left alone.
    expect(getSession(notVotedIn.session.id)!.revision).toBe(untouchedBefore);
  });
});

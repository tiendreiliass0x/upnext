import { describe, expect, it } from "vitest";
import {
  createAccount,
  getAccountByPhone,
  getAccountByToken,
  normalizePhone,
  toPublicAccount,
  updateAccountProfile,
} from "@/lib/accounts";
import { getAccountFromRequest } from "@/lib/auth";
import { getDatabase } from "@/lib/db";
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
      avatarUrl: null,
      tagline: "",
    });
    expect(toPublicAccount(account)).not.toHaveProperty("authToken");
    expect(toPublicAccount(account)).not.toHaveProperty("phone");
  });

  it("updates a pseudonym without rotating the account token", () => {
    const account = createAccount({
      phone: "+32470987654",
      pseudonym: "Old Name",
    });
    const updated = updateAccountProfile(account, { pseudonym: "Mint Fox" });

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

describe("editing one field at a time", () => {
  it("writes only the field it was given, so two edits cannot undo each other", () => {
    const account = createAccount({
      phone: "+32470123401",
      pseudonym: "Original",
    });

    // Two requests that both read this snapshot and change different fields.
    // A write that filled the untouched column in from the snapshot would
    // carry the other one's pre-edit value back over the top of it.
    updateAccountProfile(account, { pseudonym: "Renamed" });
    updateAccountProfile(account, { tagline: "Vinyl only" });

    const stored = getAccountByToken(account.authToken)!;
    expect(stored.pseudonym).toBe("Renamed");
    expect(stored.tagline).toBe("Vinyl only");
  });

  it("does not write when nothing actually changed", () => {
    const account = createAccount({
      phone: "+32470123402",
      pseudonym: "Steady",
    });
    const { session } = createSession({
      name: "Set",
      venue: "",
      accountId: account.id,
      requestId: crypto.randomUUID(),
      tracks: [{ title: "Opener", artist: "A" }],
    });
    const before = getSession(session.id)!.revision;

    // An empty edit, and one that resubmits what is already stored. Writing
    // for either would bump every room this account is visible in, which a
    // caller could repeat to defeat the room's 304 polling.
    updateAccountProfile(account, {});
    updateAccountProfile(account, { pseudonym: "Steady", tagline: "" });
    updateAccountProfile(account, { pseudonym: "  Steady  " });

    expect(getSession(session.id)!.revision).toBe(before);
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

    updateAccountProfile(host, { pseudonym: "New DJ" });

    const after = getSession(created.session.id)!;
    expect(after.djName).toBe("New DJ");
    expect(after.revision).toBe(before.revision + 1);
  });

  it("refreshes the name in a room held open past its own expiry", () => {
    const host = createAccount({ phone: "+32470005004", pseudonym: "Old DJ" });
    const created = createSession({
      name: "Set",
      venue: "",
      accountId: host.id,
      requestId: crypto.randomUUID(),
      keepOpen: true,
      tracks: [{ title: "T", artist: "A" }],
    });
    // A room the DJ holds open outlives its expires_at, which is exactly the
    // state a bump keyed on "expires_at is still ahead" would step over: its
    // guests would keep hearing 304 and showing the old name for good.
    getDatabase()
      .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), created.session.id);
    const before = getSession(created.session.id)!;

    updateAccountProfile(host, { pseudonym: "New DJ" });

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
    expect(before.tracks[0].voters).toEqual([
      { name: "Old Name", avatarUrl: null },
    ]);

    updateAccountProfile(fan, { pseudonym: "New Name" });

    const after = getSession(votedIn.session.id)!;
    // A guest polling with the old ETag now gets a body instead of a 304.
    expect(after.revision).toBe(before.revision + 1);
    expect(after.tracks[0].voters).toEqual([
      { name: "New Name", avatarUrl: null },
    ]);
    expect(after.voters).toEqual([{ name: "New Name", avatarUrl: null }]);
    // Rooms the account never voted in are left alone.
    expect(getSession(notVotedIn.session.id)!.revision).toBe(untouchedBefore);
  });
});

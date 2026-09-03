import { afterEach, describe, expect, it } from "vitest";
import { GET as listAccountStatus } from "@/app/api/admin/accounts/route";
import { createAccount } from "@/lib/accounts";
import { adminTokenHeader } from "@/lib/admin";
import { addLibraryTrack, createLibrary } from "@/lib/libraries";
import { createPlaylist } from "@/lib/playlists";
import { createSession, registerAudioUpload } from "@/lib/sessions";
import { setupTestDatabase } from "./helpers/database";

setupTestDatabase();

const originalAdminToken = process.env.ADMIN_TOKEN;
afterEach(() => {
  if (originalAdminToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = originalAdminToken;
});

function request(admin?: string) {
  return new Request("http://localhost/api/admin/accounts", {
    headers: admin ? { [adminTokenHeader]: admin } : {},
  });
}

describe("admin account status", () => {
  it("requires the admin credential and reports account usage", async () => {
    process.env.ADMIN_TOKEN = "super-admin";
    const account = createAccount({
      phone: "+32470006001",
      pseudonym: "Curator",
    });
    registerAudioUpload({
      objectKey: "audio/curator/in-library.mp3",
      accountId: account.id,
      originalName: "one.mp3",
      sizeBytes: 10,
    });
    registerAudioUpload({
      objectKey: "audio/curator/not-in-library.mp3",
      accountId: account.id,
      originalName: "two.mp3",
      sizeBytes: 20,
    });
    const library = createLibrary({ name: "House", description: "" });
    addLibraryTrack({
      libraryId: library.id,
      title: "One",
      artist: "A",
      previewKey: "audio/curator/in-library.mp3",
      contributedBy: account.id,
    });
    createPlaylist({ accountId: account.id, name: "Set" });
    createSession({
      name: "Live room",
      venue: "",
      accountId: account.id,
      tracks: [],
    });

    expect((await listAccountStatus(request())).status).toBe(403);
    const response = await listAccountStatus(request("super-admin"));
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0]).toMatchObject({
      id: account.id,
      pseudonym: "Curator",
      phoneLast4: "6001",
      uploadCount: 2,
      storageBytes: 30,
      libraryTrackCount: 1,
      uploadsNotInLibrary: 1,
      playlistCount: 1,
      activeRoomCount: 1,
    });
  });

  it("does not call a preview a room is using an orphan", async () => {
    process.env.ADMIN_TOKEN = "super-admin";
    const account = createAccount({
      phone: "+32470006002",
      pseudonym: "Booth DJ",
    });
    registerAudioUpload({
      objectKey: "audio/booth/room-song.mp3",
      accountId: account.id,
      originalName: "room-song.mp3",
      sizeBytes: 40,
    });
    // The ordinary booth flow: uploaded for a room, never catalogued. Cleanup
    // treats a track reference as a live claim on the object, and so must the
    // warning, or every DJ who never touches the catalogue reads as a leak.
    createSession({
      name: "Live room",
      venue: "",
      accountId: account.id,
      tracks: [
        { title: "Room Song", artist: "A", previewKey: "audio/booth/room-song.mp3" },
      ],
    });

    const response = await listAccountStatus(request("super-admin"));
    const data = (await response.json()) as {
      accounts: Array<Record<string, unknown>>;
    };
    const row = data.accounts.find((entry) => entry.id === account.id);
    expect(row).toMatchObject({ uploadCount: 1, uploadsNotInLibrary: 0 });
  });
});

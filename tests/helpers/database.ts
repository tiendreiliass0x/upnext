import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { closeDatabase } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";

export function setupTestDatabase() {
  let directory = "";
  let databasePath = "";

  beforeEach(() => {
    closeDatabase();
    resetRateLimits();
    directory = mkdtempSync(join(tmpdir(), "upnext-test-"));
    databasePath = join(directory, "test.sqlite");
    process.env.SQLITE_PATH = databasePath;
  });

  afterEach(() => {
    closeDatabase();
    delete process.env.SQLITE_PATH;
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    get path() {
      return databasePath;
    },
  };
}

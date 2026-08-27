import { loadEnvConfig } from "@next/env";
import { describe, expect, it } from "vitest";
import { deletePreview, getPreviewUrl, uploadPreview } from "@/lib/r2";

loadEnvConfig(process.cwd());

describe.skipIf(process.env.RUN_R2_INTEGRATION !== "1")(
  "live R2 integration",
  () => {
    it("uploads, signs, downloads, and deletes a QA object", async () => {
      const objectKey = `qa/tests/${crypto.randomUUID()}.mp3`;
      const payload = Buffer.from("ID3 automated R2 integration test");

      try {
        await uploadPreview(objectKey, payload);
        const signedUrl = await getPreviewUrl(objectKey);
        const response = await fetch(signedUrl);
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(payload);
      } finally {
        await deletePreview(objectKey);
      }
    }, 30_000);
  },
);

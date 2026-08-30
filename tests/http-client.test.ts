import { afterEach, describe, expect, it, vi } from "vitest";
import { readJson } from "@/lib/http-client";

describe("HTTP response parsing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops waiting when a JSON response body stalls", async () => {
    vi.useFakeTimers();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
      }),
    );

    const parsing = readJson(response, 1000);
    const rejection = expect(parsing).rejects.toThrow("connection timed out");
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
  });

  it("still reports a completed non-JSON response clearly", async () => {
    await expect(readJson(new Response("upstream failed"))).rejects.toThrow(
      "unexpected response (200)",
    );
  });
});

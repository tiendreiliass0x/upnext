import { describe, expect, it } from "vitest";
import {
  InvalidTipHandleError,
  normalizeTipHandles,
  tipLinksFor,
} from "@/lib/tips";

describe("tip handles", () => {
  it("normalizes optional provider prefixes and builds fixed provider links", () => {
    const handles = normalizeTipHandles({
      cashApp: "  $NightOwl7 ",
      venmo: " @night-owl_7 ",
    });

    expect(handles).toEqual({ cashApp: "NightOwl7", venmo: "night-owl_7" });
    expect(tipLinksFor(handles)).toEqual({
      cashApp: "https://cash.app/$NightOwl7",
      venmo: "https://account.venmo.com/u/night-owl_7",
    });
  });

  it("keeps an unconfigured room free of payment links", () => {
    expect(normalizeTipHandles({ cashApp: "", venmo: null })).toEqual({
      cashApp: null,
      venmo: null,
    });
    expect(tipLinksFor({ cashApp: null, venmo: null })).toEqual({
      cashApp: null,
      venmo: null,
    });
  });

  it.each([
    [{ cashApp: "12345" }, "Cash App"],
    // Passes a "has a letter somewhere" rule, but cash.app/$1owl is a 404.
    [{ cashApp: "1owl" }, "Cash App"],
    [{ cashApp: "$" }, "Cash App"],
    [{ cashApp: "owl".padEnd(21, "7") }, "Cash App"],
    [{ cashApp: "not/a/cashtag" }, "Cash App"],
    [{ venmo: "x" }, "Venmo"],
    [{ venmo: "@" }, "Venmo"],
    [{ venmo: "four" }, "Venmo"],
    [{ venmo: "not/a/username" }, "Venmo"],
  ])("rejects an unsafe or malformed handle", (input, provider) => {
    expect(() => normalizeTipHandles(input)).toThrow(InvalidTipHandleError);
    expect(() => normalizeTipHandles(input)).toThrow(provider);
  });
});

import { describe, it, expect } from "vitest";
import { isAntiCrawl } from "../dist/fallback.js";
import type { FetchFallbackPolicy } from "@knowself/contracts";

const basePolicy: FetchFallbackPolicy = {
  enabled: true,
  primary_source_id: "fetch",
  fallback_source_id: "chrome-devtools",
  min_content_length: 100,
  fallback_keywords: ["captcha", "Access Denied", "forbidden"],
  trigger_on_non_2xx: true,
  include_hint: false,
};

describe("isAntiCrawl", () => {
  it("returns false when policy is disabled", () => {
    expect(isAntiCrawl("short", { ...basePolicy, enabled: false })).toBe(false);
  });

  it("returns true when content is too short", () => {
    expect(isAntiCrawl("too short", basePolicy)).toBe(true);
  });

  it("returns false when content meets length threshold", () => {
    const longContent = "a".repeat(200);
    expect(isAntiCrawl(longContent, basePolicy)).toBe(false);
  });

  it("returns true on keyword match (case insensitive)", () => {
    const content = "a".repeat(200) + " Access Denied ";
    expect(isAntiCrawl(content, basePolicy)).toBe(true);
  });

  it("returns true on captcha keyword", () => {
    const content = "a".repeat(200) + " please enter captcha ";
    expect(isAntiCrawl(content, basePolicy)).toBe(true);
  });
});

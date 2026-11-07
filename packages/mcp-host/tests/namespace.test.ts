import { describe, it, expect } from "vitest";
import { toFullName, fromFullName, ensureSourceId } from "../dist/namespace.js";

describe("toFullName", () => {
  it("combines sourceId and bareName with __ separator", () => {
    expect(toFullName("fetch" as never, "get" as never)).toBe("fetch__get");
  });

  it("throws if sourceId contains __", () => {
    expect(() => toFullName("bad__id" as never, "tool" as never)).toThrow(
      'sourceId must not contain "__"',
    );
  });
});

describe("fromFullName", () => {
  it("splits full name into sourceId and bareName", () => {
    const result = fromFullName("fetch__get_page" as never);
    expect(result).toEqual({ sourceId: "fetch", bareName: "get_page" });
  });

  it("handles bareName containing __", () => {
    const result = fromFullName("src__a__b" as never);
    expect(result).toEqual({ sourceId: "src", bareName: "a__b" });
  });

  it("returns null for names without separator", () => {
    expect(fromFullName("notoolseparator" as never)).toBeNull();
  });

  it("returns null for empty bareName", () => {
    expect(fromFullName("src__" as never)).toBeNull();
  });
});

describe("ensureSourceId", () => {
  it("returns the string cast to ToolSourceId if valid", () => {
    expect(ensureSourceId("fetch")).toBe("fetch");
  });

  it("throws if sourceId contains __", () => {
    expect(() => ensureSourceId("bad__id")).toThrow('sourceId must not contain "__"');
  });
});

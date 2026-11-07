import { describe, it, expect } from "vitest";
import { parseJsonColumn, stringifyJsonColumn } from "../src/json";

describe("parseJsonColumn", () => {
  it("parses valid JSON", () => {
    expect(parseJsonColumn('["a","b"]', [])).toEqual(["a", "b"]);
  });

  it("returns fallback for null", () => {
    expect(parseJsonColumn(null, ["default"])).toEqual(["default"]);
  });

  it("returns fallback for undefined", () => {
    expect(parseJsonColumn(undefined, [])).toEqual([]);
  });

  it("returns fallback for empty string", () => {
    expect(parseJsonColumn("", { hello: "world" })).toEqual({ hello: "world" });
  });

  it("returns fallback for malformed JSON", () => {
    expect(parseJsonColumn("not-json", [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("handles objects", () => {
    const fallback = {};
    expect(parseJsonColumn('{"x":1}', fallback)).toEqual({ x: 1 });
  });

  it("handles numbers", () => {
    expect(parseJsonColumn("42", 0)).toBe(42);
  });
});

describe("stringifyJsonColumn", () => {
  it("stringifies arrays", () => {
    expect(stringifyJsonColumn(["a", "b"])).toBe('["a","b"]');
  });

  it("stringifies objects", () => {
    expect(stringifyJsonColumn({ x: 1 })).toBe('{"x":1}');
  });

  it("stringifies primitives", () => {
    expect(stringifyJsonColumn(42)).toBe("42");
  });
});

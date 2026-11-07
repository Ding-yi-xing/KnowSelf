import { describe, it, expect } from "vitest";
import { toHttpStatus, toEventErrorCode } from "../src/errors";

describe("toHttpStatus", () => {
  it("已知 ProfileErrorCode 各返回正确状态码", () => {
    const cases: [string, number][] = [
      ["PROFILE_NOT_FOUND", 404],
      ["DB_BUSY", 503],
      ["DB_CORRUPT", 500],
      ["CONSTRAINT_VIOLATION", 422],
      ["INVALID_TARGET_REF", 400],
      ["AUTOWRITE_REJECTED", 403],
    ];
    for (const [code, expected] of cases) {
      expect(toHttpStatus(code)).toBe(expected);
    }
  });

  it("已知 RetrievalErrorCode 各返回正确状态码", () => {
    const cases: [string, number][] = [
      ["EMBED_MODEL_LOAD_FAILED", 500],
      ["DB_CORRUPT", 500],
      ["INDEX_BUSY", 503],
      ["BUDGET_OVERFLOW", 422],
      ["ABORTED", 499],
    ];
    for (const [code, expected] of cases) {
      expect(toHttpStatus(code)).toBe(expected);
    }
  });

  it("已知 ProviderErrorCode 各返回正确状态码", () => {
    const cases: [string, number][] = [
      ["PROVIDER_NOT_FOUND", 400],
      ["PROVIDER_DEAD", 503],
      ["AUTH_FAILED", 401],
      ["RATE_LIMITED", 502],
      ["UPSTREAM_5XX", 502],
      ["STREAM_BROKEN", 502],
      ["TOOL_LOOP_OVERFLOW", 502],
      ["ABORTED", 499],
    ];
    for (const [code, expected] of cases) {
      expect(toHttpStatus(code)).toBe(expected);
    }
  });

  it("已知 McpErrorCode 各返回正确状态码", () => {
    const cases: [string, number][] = [
      ["SERVER_NOT_FOUND", 404],
      ["SERVER_DISABLED", 404],
      ["SPAWN_FAILED", 500],
      ["STARTUP_TIMEOUT", 503],
      ["RPC_TIMEOUT", 504],
      ["RPC_ERROR", 502],
      ["DEAD_COOLDOWN", 503],
      ["INVALID_TRANSPORT", 400],
    ];
    for (const [code, expected] of cases) {
      expect(toHttpStatus(code)).toBe(expected);
    }
  });

  it("已知 SettingsErrorCode 各返回正确状态码", () => {
    const cases: [string, number][] = [
      ["PARSE_FAILED", 422],
      ["VALIDATION", 422],
      ["WRITE_FAILED", 500],
      ["REFERENCE_INVALID", 400],
      ["VERSION_MISMATCH", 409],
    ];
    for (const [code, expected] of cases) {
      expect(toHttpStatus(code)).toBe(expected);
    }
  });

  it("已知 SourceErrorCode 各返回正确状态码", () => {
    const cases: [string, number][] = [
      ["SOURCE_NOT_FOUND", 404],
      ["PROPOSAL_NOT_FOUND", 404],
      ["UNSUPPORTED_MIME", 415],
      ["EXTRACTOR_FAILED", 422],
      ["URL_FETCH_FAILED", 502],
      ["FILE_TOO_LARGE", 413],
      ["PROPOSAL_NOT_PENDING", 409],
      ["DISTILL_FAILED", 502],
      ["INVALID_TARGET_REF", 400],
    ];
    for (const [code, expected] of cases) {
      expect(toHttpStatus(code)).toBe(expected);
    }
  });

  it("未知错误码返回 500", () => {
    expect(toHttpStatus("UNKNOWN_CODE")).toBe(500);
  });
});

describe("toEventErrorCode", () => {
  it("已知码原样返回，未知码返回 'INTERNAL'", () => {
    expect(toEventErrorCode("BAD_REQUEST")).toBe("BAD_REQUEST");
    expect(toEventErrorCode("NOT_FOUND")).toBe("NOT_FOUND");
    expect(toEventErrorCode("UNKNOWN")).toBe("INTERNAL");
  });
});

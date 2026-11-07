import { describe, it, expect } from "vitest";
import {
  IngestionError,
  SourceNotFoundError,
  ProposalNotFoundError,
  UnsupportedMimeError,
  ExtractorFailedError,
  UrlFetchFailedError,
  FileTooLargeError,
  ProposalNotPendingError,
  DistillFailedError,
  InvalidTargetRefError,
} from "../src/errors";

describe("IngestionError", () => {
  it("基类的 toPayload() 返回 { code, message }", () => {
    const err = new IngestionError("SOURCE_NOT_FOUND", "test error");
    const payload = err.toPayload();
    expect(payload).toEqual({ code: "SOURCE_NOT_FOUND", message: "test error" });
  });

  it("9 个具名子类构造后 .name 各自正确", () => {
    const cases: [string, IngestionError][] = [
      ["SourceNotFoundError", new SourceNotFoundError("id")],
      ["ProposalNotFoundError", new ProposalNotFoundError("id")],
      ["UnsupportedMimeError", new UnsupportedMimeError("mime")],
      ["ExtractorFailedError", new ExtractorFailedError("mime", "detail")],
      ["UrlFetchFailedError", new UrlFetchFailedError("url", "detail")],
      ["FileTooLargeError", new FileTooLargeError(10_000)],
      ["ProposalNotPendingError", new ProposalNotPendingError("id", "accepted")],
      ["DistillFailedError", new DistillFailedError("detail")],
      ["InvalidTargetRefError", new InvalidTargetRefError("detail")],
    ];
    for (const [name, err] of cases) {
      expect(err.name).toBe(name);
      expect(typeof err.code).toBe("string");
      expect(err.code.length).toBeGreaterThan(0);
    }
  });

  it("SourceNotFoundError(id) 的 message 含 id", () => {
    const err = new SourceNotFoundError("src-001");
    expect(err.message).toContain("src-001");
  });

  it("UnsupportedMimeError(mime) 的 message 含 mime", () => {
    const err = new UnsupportedMimeError("image/png");
    expect(err.message).toContain("image/png");
  });

  it("FileTooLargeError(maxBytes) 的 message 含 maxBytes 数字", () => {
    const err = new FileTooLargeError(10_485_760);
    expect(err.message).toContain("10485760");
  });
});

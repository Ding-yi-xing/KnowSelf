import { describe, it, expect } from "vitest";
import { inferMime, isSupportedMime } from "../src/mime";

describe("inferMime", () => {
  it("returns text/plain for .txt", () => {
    expect(inferMime("readme.txt")).toBe("text/plain");
  });

  it("returns text/markdown for .md", () => {
    expect(inferMime("notes.md")).toBe("text/markdown");
  });

  it("returns text/markdown for .markdown", () => {
    expect(inferMime("readme.markdown")).toBe("text/markdown");
  });

  it("returns text/html for .html", () => {
    expect(inferMime("page.html")).toBe("text/html");
  });

  it("returns text/html for .htm", () => {
    expect(inferMime("legacy.htm")).toBe("text/html");
  });

  it("returns application/pdf for .pdf", () => {
    expect(inferMime("report.pdf")).toBe("application/pdf");
  });

  it("returns DOCX mime for .docx", () => {
    expect(inferMime("paper.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("returns text/csv for .csv", () => {
    expect(inferMime("data.csv")).toBe("text/csv");
  });

  it("returns XLSX mime for .xlsx", () => {
    expect(inferMime("sheet.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("returns image mime types for common image extensions", () => {
    expect(inferMime("image.png")).toBe("image/png");
    expect(inferMime("photo.jpg")).toBe("image/jpeg");
    expect(inferMime("photo.jpeg")).toBe("image/jpeg");
    expect(inferMime("cover.webp")).toBe("image/webp");
    expect(inferMime("anim.gif")).toBe("image/gif");
  });

  it("returns null for unknown extension", () => {
    expect(inferMime("archive.bin")).toBeNull();
  });

  it("returns null for no extension", () => {
    expect(inferMime("Makefile")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(inferMime("README.MD")).toBe("text/markdown");
  });

  it("handles multiple dots", () => {
    expect(inferMime("archive.tar.gz")).toBeNull();
    expect(inferMime("data.backup.csv")).toBe("text/csv");
  });
});

describe("isSupportedMime", () => {
  it("returns true for supported mime", () => {
    expect(isSupportedMime("text/plain")).toBe(true);
    expect(isSupportedMime("text/markdown")).toBe(true);
    expect(isSupportedMime("application/pdf")).toBe(true);
    expect(isSupportedMime("image/png")).toBe(true);
    expect(isSupportedMime("image/jpeg")).toBe(true);
  });

  it("returns false for unsupported mime", () => {
    expect(isSupportedMime("video/mp4")).toBe(false);
    expect(isSupportedMime("application/octet-stream")).toBe(false);
  });
});

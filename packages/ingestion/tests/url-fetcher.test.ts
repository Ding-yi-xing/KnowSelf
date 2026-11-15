import { describe, it, expect } from "vitest";
import { fetchUrlAsSource } from "../src/url-fetcher.js";
import { UrlFetchFailedError } from "../src/errors.js";

function makeMockRegistry(
  invokeImpl: (name: string, input: unknown) => { is_error: boolean; output: string },
) {
  return {
    list: () => [],
    get: () => null,
    invoke: async (inv: { name: string; input: unknown }) => invokeImpl(inv.name, inv.input),
    onChange: () => () => {},
    mergeFromSource: () => {},
    registerClient: () => {},
    getClient: () => undefined,
  };
}

describe("fetchUrlAsSource", () => {
  it("returns text and contentType on successful fetch", async () => {
    const registry = makeMockRegistry(() => ({
      is_error: false,
      output: JSON.stringify({ text: "# Hello\n\nWorld", contentType: "text/markdown" }),
    }));

    const result = await fetchUrlAsSource(
      { toolRegistry: registry as never, conversationId: "conv-1" },
      "https://example.com/doc.md",
    );

    expect(result.text).toContain("# Hello");
    expect(result.contentType).toBe("text/markdown");
  });

  it("parses body+headers shape as fallback", async () => {
    const registry = makeMockRegistry(() => ({
      is_error: false,
      output: JSON.stringify({
        body: "<html><body><p>Hello World</p></body></html>",
        headers: { "content-type": "text/html" },
      }),
    }));

    const result = await fetchUrlAsSource(
      { toolRegistry: registry as never, conversationId: "conv-1" },
      "https://example.com",
    );

    expect(result.text).toContain("Hello World");
    expect(result.contentType).toBe("text/html");
  });

  it("throws URL_FETCH_FAILED when tool returns is_error=true", async () => {
    const registry = makeMockRegistry(() => ({
      is_error: true,
      output: "Access Denied — captcha required",
    }));

    await expect(
      fetchUrlAsSource(
        { toolRegistry: registry as never, conversationId: "conv-1" },
        "https://blocked.example.com",
      ),
    ).rejects.toThrow(UrlFetchFailedError);
  });

  it("throws URL_FETCH_FAILED on unparseable output", async () => {
    const registry = makeMockRegistry(() => ({
      is_error: false,
      output: "not valid json",
    }));

    await expect(
      fetchUrlAsSource(
        { toolRegistry: registry as never, conversationId: "conv-1" },
        "https://example.com",
      ),
    ).rejects.toThrow(UrlFetchFailedError);
  });
});

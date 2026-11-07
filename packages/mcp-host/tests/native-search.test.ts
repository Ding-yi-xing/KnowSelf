import { describe, expect, it, vi } from "vitest";
import { createNativeSearchClient } from "../src/native-search";

describe("native search client", () => {
  it("registers web_search__search and returns parsed result JSON", async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="/l/?kh=-1&uddg=https%3A%2F%2Fexample.test%2Fresult">Example &amp; Result</a>
        <a class="result__snippet">A short <b>search</b> snippet.</a>
      </div>
    `;
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const client = createNativeSearchClient({
      sourceId: "web_search" as never,
      fetchImpl: fetchImpl as never,
      now: () => "2026-01-01T00:00:00.000Z",
    });

    const tools = await client.listTools();
    expect(tools[0]!.name).toBe("web_search__search");

    const result = await client.invoke("search" as never, {
      query: "福建 国企 单位",
      max_results: 3,
    });
    const output = JSON.parse(result.output) as {
      query: string;
      results: Array<{ title: string; url: string; snippet: string }>;
    };

    expect(result.is_error).toBe(false);
    expect(output.query).toBe("福建 国企 单位");
    expect(output.results).toEqual([
      {
        title: "Example & Result",
        url: "https://example.test/result",
        snippet: "A short search snippet.",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("q=%E7%A6%8F%E5%BB%BA+%E5%9B%BD%E4%BC%81+%E5%8D%95%E4%BD%8D"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("validates query input", async () => {
    const client = createNativeSearchClient({
      sourceId: "web_search" as never,
      fetchImpl: vi.fn() as never,
    });

    const result = await client.invoke("search" as never, { query: " " });

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("INPUT_VALIDATION");
  });
});

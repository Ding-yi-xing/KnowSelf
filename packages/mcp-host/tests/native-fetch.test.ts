import { describe, expect, it, vi } from "vitest";
import { createNativeFetchClient } from "../src/native-fetch";

describe("native fetch client", () => {
  it("registers fetch__fetch and returns text/contentType JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("hello from page", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
    const client = createNativeFetchClient({
      sourceId: "fetch" as never,
      fetchImpl: fetchImpl as never,
      now: () => "2026-01-01T00:00:00.000Z",
    });

    const tools = await client.listTools();
    expect(tools[0]!.name).toBe("fetch__fetch");

    const result = await client.invoke("fetch" as never, { url: "https://example.test/a" });
    const output = JSON.parse(result.output) as { text: string; contentType: string };

    expect(result.is_error).toBe(false);
    expect(output.text).toBe("hello from page");
    expect(output.contentType).toContain("text/plain");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/a",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects non-http URLs", async () => {
    const client = createNativeFetchClient({
      sourceId: "fetch" as never,
      fetchImpl: vi.fn() as never,
    });

    const result = await client.invoke("fetch" as never, { url: "file:///etc/passwd" });

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("INPUT_VALIDATION");
  });
});

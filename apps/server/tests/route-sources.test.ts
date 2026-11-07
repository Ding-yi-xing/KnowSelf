import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sourceRoutes } from "../src/routes/sources";
import { onError } from "../src/middleware/error";
import type { Runtime } from "../src/runtime";
import { DistillFailedError } from "@knowself/ingestion";
import type { SourceStored } from "@knowself/contracts";

const source: SourceStored = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  kind: "paste",
  original_name: "note",
  mime_type: "text/plain",
  file_path: null,
  url: null,
  extracted_text: "hello",
  truncated: false,
  char_count: 5,
  user_note: "",
  user_tags: [],
  status: "raw",
  metadata: {},
  created_at: "2026-01-01T00:00:00.000Z",
  last_ingested_at: null,
  last_error: null,
};

function makeApp(runtime: Runtime) {
  const app = new Hono();
  app.onError(onError);
  app.route("/api/sources", sourceRoutes(runtime));
  return app;
}

describe("source routes", () => {
  it("maps missing source through shared error middleware", async () => {
    const err = new Error("missing") as Error & { code: string };
    err.code = "PROFILE_NOT_FOUND";
    const app = makeApp({
      profileStore: {
        sources: {
          get: vi.fn(() => {
            throw err;
          }),
        },
      },
    } as unknown as Runtime);

    const res = await app.request("/api/sources/550e8400-e29b-41d4-a716-446655440000");

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "SOURCE_NOT_FOUND" });
  });

  it("maps distill failures to 502 through shared error middleware", async () => {
    const app = makeApp({
      profileStore: {
        sources: {
          get: vi.fn(() => source),
        },
      },
      ingestion: {
        runDistill: vi.fn(() => {
          throw new DistillFailedError("provider down");
        }),
      },
    } as unknown as Runtime);

    const res = await app.request(`/api/sources/${source.id}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: "", focus_hints: [], max_proposals: 4 }),
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "DISTILL_FAILED" });
  });
});

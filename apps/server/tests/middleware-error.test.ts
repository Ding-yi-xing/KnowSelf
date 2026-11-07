import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { onError } from "../src/middleware/error";
import { z } from "zod";

function makeApp() {
  const app = new Hono();
  app.onError(onError);
  return app;
}

describe("errorMiddleware", () => {
  it("passes through successful responses", async () => {
    const app = makeApp();
    app.get("/ok", (c) => c.json({ ok: true }));

    const res = await app.request("/ok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("catches ZodError -> 422", async () => {
    const app = makeApp();
    app.get("/bad", () => {
      const schema = z.object({ name: z.string() });
      schema.parse({ name: 123 });
    });

    const res = await app.request("/bad");
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
  });

  it("catches Error with code -> mapped status", async () => {
    const app = makeApp();
    app.get("/nf", () => {
      const err = new Error("Not found") as Error & { code: string };
      err.code = "NOT_FOUND";
      throw err;
    });

    const res = await app.request("/nf");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("catches unknown error -> 500", async () => {
    const app = makeApp();
    app.get("/crash", () => {
      throw new Error("boom");
    });

    const res = await app.request("/crash");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    expect(body.message).toBe("Internal server error");
  });

  it("catches error with toPayload method", async () => {
    const app = makeApp();
    app.get("/payload", () => {
      const err = new Error("db busy") as Error & { toPayload: () => Record<string, unknown> };
      err.toPayload = () => ({ code: "DB_BUSY", message: "Database busy" });
      throw err;
    });

    const res = await app.request("/payload");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("DB_BUSY");
  });
});

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { zValidate } from "../src/middleware/validate";
import { onError } from "../src/middleware/error";

describe("zValidate middleware", () => {
  it("parses valid JSON body and sets validated context", async () => {
    const app = new Hono();
    app.onError(onError);
    const schema = z.object({ name: z.string(), age: z.number() });
    app.post("/test", zValidate(schema, "json"), (c) => {
      const v = c.get("validated") as z.infer<typeof schema>;
      return c.json(v);
    });

    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice", age: 30 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Alice", age: 30 });
  });

  it("throws ZodError for invalid JSON body -> 422", async () => {
    const app = new Hono();
    app.onError(onError);
    const schema = z.object({ name: z.string() });
    app.post("/test", zValidate(schema, "json"), (c) => {
      return c.json(c.get("validated"));
    });

    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: 123 }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
  });

  it("parses query params and coerces numbers", async () => {
    const app = new Hono();
    app.onError(onError);
    const schema = z.object({
      limit: z.number().int().default(10),
      page: z.number().int().default(1),
    });
    app.get("/test", zValidate(schema, "query"), (c) => {
      return c.json(c.get("validated"));
    });

    const res = await app.request("/test?limit=25&page=3");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(25);
    expect(body.page).toBe(3);
  });

  it("uses defaults for missing query params", async () => {
    const app = new Hono();
    app.onError(onError);
    const schema = z.object({
      limit: z.number().int().default(10),
    });
    app.get("/test", zValidate(schema, "query"), (c) => {
      return c.json(c.get("validated"));
    });

    const res = await app.request("/test");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(10);
  });
});

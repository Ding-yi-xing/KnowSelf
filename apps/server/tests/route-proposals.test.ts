import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { proposalRoutes } from "../src/routes/proposals";
import type { Runtime } from "../src/runtime";

function makeApp(runtime: Runtime) {
  const app = new Hono();
  app.route("/api/proposals", proposalRoutes(runtime));
  return app;
}

function runtimeWithDecideError(code: string): Runtime {
  return {
    ingestion: {
      acceptProposal: () => {
        const err = new Error("decide failed") as Error & { code: string };
        err.code = code;
        throw err;
      },
    },
  } as Runtime;
}

describe("proposal routes", () => {
  it("maps invalid proposal targets to 400 instead of 500", async () => {
    const app = makeApp(runtimeWithDecideError("INVALID_TARGET_REF"));

    const res = await app.request("/api/proposals/invalid-target/decide", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "accept" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_TARGET_REF" });
  });

  it("maps profile constraint failures to 409 instead of 500", async () => {
    const app = makeApp(runtimeWithDecideError("CONSTRAINT_VIOLATION"));

    const res = await app.request("/api/proposals/constraint/decide", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "accept" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "CONSTRAINT_VIOLATION" });
  });
});

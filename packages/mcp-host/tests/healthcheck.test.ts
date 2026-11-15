import { describe, it, expect, vi } from "vitest";
import { runStartupCheck } from "../src/healthcheck.js";
import { createStatusTracker } from "../src/status.js";

function makeMockClient(listToolsImpl: () => Promise<unknown[]>) {
  return {
    sourceId: "test" as never,
    listTools: vi.fn().mockImplementation(listToolsImpl),
    invoke: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("runStartupCheck", () => {
  it("sets state to healthy with ready_at on successful listTools", async () => {
    const tracker = createStatusTracker();
    tracker.set("test" as never, { state: "starting", started_at: new Date().toISOString() });

    const client = makeMockClient(async () => []);
    await runStartupCheck(client, "test" as never, tracker);

    const snap = tracker.snapshot();
    const srv = snap.servers.find((s) => s.server_id === "test")!;
    expect(srv.state).toBe("healthy");
    expect(srv.ready_at).not.toBeNull();
  });

  it("leaves state unchanged when listTools fails", async () => {
    const tracker = createStatusTracker();
    tracker.set("test" as never, { state: "starting", started_at: new Date().toISOString() });

    const client = makeMockClient(async () => {
      throw new Error("RPC failed");
    });
    await runStartupCheck(client, "test" as never, tracker);

    // State should remain starting because failure is handled by lifecycle
    const snap = tracker.snapshot();
    const srv = snap.servers.find((s) => s.server_id === "test")!;
    expect(srv.state).toBe("starting");
    expect(srv.ready_at).toBeNull();
  });
});

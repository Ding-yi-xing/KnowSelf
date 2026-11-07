import { describe, expect, it, vi } from "vitest";
import { systemRoutes } from "../src/routes/system";
import type { Runtime } from "../src/runtime";

function makeRuntime(): Runtime {
  return {
    providerAdapter: {
      listHealth: vi.fn(() => [{ id: "p1", label: "P1", healthy: true }]),
    },
    mcpHost: {
      getStatus: vi.fn(() => ({ all_ready: true, servers: [], tools: [] })),
    },
    profileStore: {
      sources: {
        countByStatus: vi.fn(() => ({ raw: 1, pending_review: 2 })),
        latestDistillAt: vi.fn(() => "2026-01-02T00:00:00.000Z"),
      },
      proposals: {
        countByStatus: vi.fn(() => ({ pending: 3, accepted: 1 })),
      },
    },
    conversationStore: {
      listConversations: vi.fn(() => ({
        items: [{ updated_at: "2026-01-03T00:00:00.000Z" }],
        total: 5,
      })),
    },
    profileDb: { open: true },
  } as unknown as Runtime;
}

describe("system routes", () => {
  it("returns real counters and environment diagnostics", async () => {
    const app = systemRoutes(makeRuntime());

    const res = await app.request("/status");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ingestion.source_count).toBe(3);
    expect(body.ingestion.pending_proposal_count).toBe(3);
    expect(body.ingestion.source_status_counts).toMatchObject({
      raw: 1,
      pending_review: 2,
      completed: 0,
    });
    expect(body.ingestion.proposal_status_counts).toMatchObject({
      pending: 3,
      accepted: 1,
      rejected: 0,
    });
    expect(body.conversations).toEqual({
      total: 5,
      latest_at: "2026-01-03T00:00:00.000Z",
    });
    expect(body.environment).toMatchObject({
      node_required: ">=20.18 <21",
      sqlite_available: true,
    });
  });
});

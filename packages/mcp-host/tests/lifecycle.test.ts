import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnAll, shutdownAll } from "../dist/lifecycle.js";
import { createToolRegistry } from "../dist/registry.js";
import { createStatusTracker } from "../dist/status.js";
import type { McpServerConfig } from "@knowself/contracts";

function makeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "test-server",
    label: "Test Server",
    transport_config: {
      transport: "stdio",
      command: "echo",
      args: [],
      env: {},
    },
    enabled: true,
    purpose: "",
    startup_timeout_ms: 1000,
    request_timeout_ms: 5000,
    max_concurrency: 2,
    restart_on_crash: true,
    max_restarts: 3,
    dead_cooldown_ms: 100,
    ...overrides,
  } as McpServerConfig;
}

// Mock createClient via module-level interception
vi.mock("../dist/client/index.js", () => ({
  createClient: vi.fn(),
}));

describe("spawnAll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets server state to healthy on successful spawn", async () => {
    const { createClient } = await import("../dist/client/index.js");
    const mockClient = {
      sourceId: "test-server",
      listTools: vi.fn().mockResolvedValue([]),
      invoke: vi.fn(),
      dispose: vi.fn(),
    };
    (createClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);

    const tracker = createStatusTracker();
    const registry = createToolRegistry();

    await spawnAll({ statusTracker: tracker, toolRegistry: registry }, [makeConfig()]);

    const snap = tracker.snapshot();
    expect(snap.servers).toHaveLength(1);
    expect(snap.servers[0]!.state).toBe("healthy");
    expect(snap.servers[0]!.ready_at).not.toBeNull();
  });

  it("sets server state to dead on spawn failure without blocking other servers", async () => {
    const { createClient } = await import("../dist/client/index.js");
    const mockGood = {
      sourceId: "good",
      listTools: vi.fn().mockResolvedValue([]),
      invoke: vi.fn(),
      dispose: vi.fn(),
    };
    (createClient as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValueOnce(mockGood);

    const tracker = createStatusTracker();
    const registry = createToolRegistry();

    await spawnAll({ statusTracker: tracker, toolRegistry: registry }, [
      makeConfig({ id: "bad" }),
      makeConfig({ id: "good" }),
    ]);

    const snap = tracker.snapshot();
    expect(snap.servers).toHaveLength(2);
    const bad = snap.servers.find((s) => s.server_id === "bad")!;
    const good = snap.servers.find((s) => s.server_id === "good")!;
    expect(bad.state).toBe("dead");
    expect(bad.last_error).toContain("spawn failed");
    expect(good.state).toBe("healthy");
  });

  it("skips disabled servers", async () => {
    const tracker = createStatusTracker();
    const registry = createToolRegistry();

    await spawnAll({ statusTracker: tracker, toolRegistry: registry }, [
      makeConfig({ enabled: false }),
    ]);

    expect(tracker.snapshot().servers).toHaveLength(0);
  });

  it("registers tools from spawned client into registry", async () => {
    const { createClient } = await import("../dist/client/index.js");
    const mockClient = {
      sourceId: "tool-server",
      listTools: vi.fn().mockResolvedValue([
        {
          name: "fetch",
          description: "Fetch URLs",
          input_schema: {},
          source_id: "tool-server" as never,
          bare_name: "fetch" as never,
        },
      ]),
      invoke: vi.fn(),
      dispose: vi.fn(),
    };
    (createClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);

    const tracker = createStatusTracker();
    const registry = createToolRegistry();

    await spawnAll({ statusTracker: tracker, toolRegistry: registry }, [
      makeConfig({ id: "tool-server" }),
    ]);

    const tools = registry.list();
    expect(tools.length).toBeGreaterThanOrEqual(1);
  });
});

describe("shutdownAll", () => {
  it("calls dispose on all clients and clears the map", async () => {
    const dispose1 = vi.fn();
    const dispose2 = vi.fn();
    const clients = new Map([
      ["a" as never, { sourceId: "a", dispose: dispose1 } as never],
      ["b" as never, { sourceId: "b", dispose: dispose2 } as never],
    ]);

    await shutdownAll(clients);

    expect(dispose1).toHaveBeenCalled();
    expect(dispose2).toHaveBeenCalled();
    expect(clients.size).toBe(0);
  });
});

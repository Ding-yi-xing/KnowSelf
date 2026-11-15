import { describe, expect, it, vi } from "vitest";
import type { KnowselfServices } from "../src/services.js";
import { startWechatImportScheduler } from "../src/wechat-import-scheduler.js";

type Tick = () => void;

function activeAutomation(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    dry_run: false,
    tick_ms: 60_000,
    tasks: [
      {
        task_id: "ingest",
        enabled: true,
        dry_run: false,
        catch_up: true,
        max_runtime_ms: 1_800_000,
        schedule: {
          kind: "interval",
          interval_ms: 60_000,
          at_hhmm: "09:00",
          weekday: 1,
          day_of_month: 1,
        },
        options: { semantic_l1: false, max_llm_calls: 200 },
      },
    ],
    wechat_imports: [
      {
        id: "wechat-main",
        source_path: "C:/private/exports/wechat",
        source_id: "source-wechat-main",
        enabled: true,
        reader: "json",
        only: ["Family"],
      },
    ],
    ...overrides,
  };
}

function services(automation: Record<string, unknown>): KnowselfServices {
  return { settings: { automation } } as unknown as KnowselfServices;
}

function harness(
  automation: Record<string, unknown>,
  importChat = vi.fn(async () => ({ status: 200, body: {} })),
) {
  let tick: Tick | undefined;
  const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
  const setInterval = vi.fn((callback: Tick) => {
    tick = callback;
    return timer;
  });
  const clearInterval = vi.fn();
  const logger = { error: vi.fn() };
  let current = new Date(2026, 10, 14, 8, 0, 0);
  const scheduler = startWechatImportScheduler(services(automation), {
    logger,
    importChat: importChat as never,
    now: () => current,
    setInterval: setInterval as never,
    clearInterval: clearInterval as never,
  });
  return {
    scheduler,
    importChat,
    logger,
    setInterval,
    clearInterval,
    timer,
    tick: () => tick?.(),
    setNow: (next: Date) => {
      current = next;
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("WeChat export import scheduler", () => {
  it("keeps disabled configuration inert and reports disabled", () => {
    const h = harness(activeAutomation({ enabled: false }));
    expect(h.importChat).not.toHaveBeenCalled();
    expect(h.scheduler.getStatus()).toMatchObject({
      mode: "disabled",
      entries: [{ state: "disabled", source_id: "source-wechat-main" }],
    });
    expect(h.setInterval).not.toHaveBeenCalled();
  });

  it.each([
    ["global", activeAutomation({ dry_run: true })],
    ["ingest task", activeAutomation({ tasks: [{ ...activeAutomation().tasks[0], dry_run: true }] })],
  ])("does not import while %s dry-run is enabled", (_label, automation) => {
    const h = harness(automation);
    expect(h.importChat).not.toHaveBeenCalled();
    expect(h.scheduler.getStatus()).toMatchObject({
      mode: "dry_run",
      entries: [{ state: "dry_run" }],
    });
  });

  it("runs catch-up with the configured stable source identity and reports success", async () => {
    const h = harness(activeAutomation());
    await flush();

    expect(h.importChat).toHaveBeenCalledWith(
      expect.anything(),
      {
        source_path: "C:/private/exports/wechat",
        source_id: "source-wechat-main",
        platform: "wechat",
        reader: "json",
        only: ["Family"],
      },
    );
    expect(h.scheduler.getStatus()).toMatchObject({
      mode: "active",
      entries: [
        {
          state: "succeeded",
          last_status: 200,
          last_started_at: new Date(2026, 10, 14, 8, 0, 0).toISOString(),
          last_finished_at: new Date(2026, 10, 14, 8, 0, 0).toISOString(),
        },
      ],
    });
    expect(h.scheduler.getStatus().entries[0]).not.toHaveProperty("source_path");
    expect(h.timer.unref).toHaveBeenCalledTimes(1);
  });

  it("records HTTP and thrown failures, logs them, and retries only at a later planned tick", async () => {
    const importChat = vi
      .fn()
      .mockResolvedValueOnce({ status: 503, body: { error: "not ready" } })
      .mockRejectedValueOnce(new Error("C:\\private\\wechat export unavailable"));
    const h = harness(activeAutomation(), importChat);
    await flush();
    expect(h.scheduler.getStatus()).toMatchObject({
      entries: [{ state: "failed", last_status: 503, last_error: "HTTP 503" }],
    });
    expect(h.logger.error).toHaveBeenCalledTimes(1);

    h.setNow(new Date(2026, 10, 14, 8, 1, 0));
    h.tick();
    await flush();
    expect(importChat).toHaveBeenCalledTimes(2);
    const status = h.scheduler.getStatus().entries[0]!;
    expect(status.state).toBe("failed");
    expect(status.last_status).toBeNull();
    expect(status.last_error).toContain("[路径已省略]");
    expect(h.logger.error).toHaveBeenCalledTimes(2);
  });

  it("does not start an overlapping import for the same directory", async () => {
    let resolveImport: ((result: { status: number; body: {} }) => void) | undefined;
    const importChat = vi.fn(
      () => new Promise<{ status: number; body: {} }>((resolve) => {
        resolveImport = resolve;
      }),
    );
    const h = harness(activeAutomation(), importChat);
    await flush();
    expect(importChat).toHaveBeenCalledTimes(1);

    h.setNow(new Date(2026, 10, 14, 8, 1, 0));
    h.tick();
    expect(importChat).toHaveBeenCalledTimes(1);
    expect(h.scheduler.getStatus()).toMatchObject({ entries: [{ state: "skipped_overlap" }] });

    resolveImport?.({ status: 200, body: {} });
    await flush();
    expect(h.scheduler.getStatus()).toMatchObject({ entries: [{ state: "succeeded" }] });
  });

  it("honors daily run windows without re-running on every scheduler tick", async () => {
    const automation = activeAutomation({
      tasks: [
        {
          ...activeAutomation().tasks[0],
          catch_up: false,
          schedule: {
            kind: "daily",
            interval_ms: 60_000,
            at_hhmm: "09:00",
            weekday: 1,
            day_of_month: 1,
          },
        },
      ],
    });
    const h = harness(automation);
    expect(h.importChat).not.toHaveBeenCalled();

    h.tick();
    await flush();
    expect(h.importChat).not.toHaveBeenCalled();
    h.setNow(new Date(2026, 10, 14, 9, 0, 0));
    h.tick();
    await flush();
    h.setNow(new Date(2026, 10, 14, 9, 1, 0));
    h.tick();
    await flush();
    expect(h.importChat).toHaveBeenCalledTimes(1);
  });

  it("clears its timer during disposal without aborting a running import", async () => {
    const h = harness(activeAutomation());
    await flush();
    h.scheduler.dispose();
    h.scheduler.dispose();
    expect(h.clearInterval).toHaveBeenCalledTimes(1);
  });
});

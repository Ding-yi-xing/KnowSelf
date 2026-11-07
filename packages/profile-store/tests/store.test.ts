import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProfileStore } from "../src/store";
import { AutowriteRejectedError } from "../src/errors";
import type { ProfileChangeEvent } from "@knowself/contracts";

describe("createProfileStore", () => {
  let tmpDir: string;

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });

  function makeStore() {
    tmpDir = mkdtempSync(join(tmpdir(), "ks-ps-"));
    return createProfileStore({
      dbPath: join(tmpDir, "profile.sqlite"),
      sourcesDir: join(tmpDir, "sources"),
      exportsDir: join(tmpDir, "exports"),
    });
  }

  it("在干净的临时目录下能成功初始化，返回 ProfileStore 实例", () => {
    const store = makeStore();
    expect(store).toHaveProperty("core");
    expect(store).toHaveProperty("cards");
    expect(store).toHaveProperty("journal");
    expect(store).toHaveProperty("sources");
    expect(store).toHaveProperty("proposals");
    expect(store).toHaveProperty("links");
    expect(store).toHaveProperty("events");
    expect(store).toHaveProperty("write");
    expect(store).toHaveProperty("exportProfile");
    expect(store).toHaveProperty("close");
    store.close();
  });

  it("createProfileStore 后再次调用打开同一 dbPath 不抛错", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ks-ps-"));
    const dbPath = join(tmpDir, "profile.sqlite");
    const s1 = createProfileStore({ dbPath, sourcesDir: tmpDir, exportsDir: tmpDir });
    s1.close();
    const s2 = createProfileStore({ dbPath, sourcesDir: tmpDir, exportsDir: tmpDir });
    expect(s2).toBeDefined();
    s2.close();
  });

  it("store.write 正常派发 core 写入并触发 events", () => {
    const store = makeStore();
    const received: ProfileChangeEvent[] = [];
    store.events.on((e) => {
      received.push(e);
    });
    store.write({ target: "core", body: "hello world", provenance: "user" }, { callerKind: "ui" });
    expect(received).toHaveLength(1);
    expect(received[0].ref_kind).toBe("core");
    expect(received[0].ref_id).toBe("core_main");
    const core = store.core.get();
    expect(core.body).toBe("hello world");
  });

  it("store.write 在 callerKind='ingestion' + provenance='user' 时抛 AutowriteRejectedError", () => {
    const store = makeStore();
    expect(() =>
      store.write({ target: "core", body: "x", provenance: "user" }, { callerKind: "ingestion" }),
    ).toThrow(AutowriteRejectedError);
    store.close();
  });

  it("store.exportProfile 调用 export 模块返回 ExportResponse 形状", async () => {
    const store = makeStore();
    store.write({ target: "core", body: "test", provenance: "user" }, { callerKind: "ui" });
    const result = await store.exportProfile({ format: "json" });
    expect(result).toHaveProperty("download_path");
    expect(result).toHaveProperty("format", "json");
    expect(result).toHaveProperty("size_bytes");
    expect(result.size_bytes).toBeGreaterThan(0);
    const fullPath = join(tmpDir, "exports", result.download_path);
    expect(existsSync(fullPath)).toBe(true);
    store.close();
  });

  it("store.close 后再调 write 抛错", () => {
    const store = makeStore();
    store.close();
    expect(() =>
      store.write({ target: "core", body: "x", provenance: "user" }, { callerKind: "ui" }),
    ).toThrow();
  });

  it("events.on 返回的 unsubscribe 函数清除订阅后不再被通知", () => {
    const store = makeStore();
    const received: string[] = [];
    const unsub = store.events.on(() => {
      received.push("A");
    });
    unsub();
    store.write({ target: "core", body: "test", provenance: "user" }, { callerKind: "ui" });
    expect(received).toEqual([]);
    store.close();
  });
});

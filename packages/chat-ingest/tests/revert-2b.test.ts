/**
 * 批 2b —— 回滚四步 ② 的生产接线（`snapshotCursors`）+ `restored > 0`。
 *
 * 主干缺陷：`staging-batches.snapshotCursors` 生产零调用 ⇒
 * `ingest_batches.cursor_snapshot_json` 恒 NULL ⇒ `restoreCursors` 恒 {restored:0}（回滚静默空转）。
 * 本文件从 `ingestExport` 真实入口验证，而不是手动调 snapshotCursors 自证。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersonStore, type PersonStore } from "@knowself/person-store";
import { ingestExport } from "../src/index";
import { defaultExportDir } from "./fixtures";

const T1 = "2026-11-07T08:00:00.000Z";
const T2 = "2026-11-07T09:00:00.000Z";

let dir: string;
let store: PersonStore;
const scratch: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "knowself-revert2b-"));
  scratch.push(dir);
  store = createPersonStore({ dbPath: join(dir, "persons.sqlite"), encryption: { mode: "none" } });
});

afterEach(() => {
  store.close();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("回滚四步 ②：ingestExport 真的采集游标快照", () => {
  it("legacy 模式：ingest_batches.cursor_snapshot_json 非 NULL 且是合法 JSON", async () => {
    const exportDir = defaultExportDir();
    scratch.push(exportDir);
    const result = await ingestExport({ store, dir: exportDir, now: T1 });

    const snapshot = store.staging.getBatch(result.batch_id)?.cursor_snapshot_json;
    expect(snapshot).not.toBeNull();
    expect(snapshot).toBeDefined();
    expect(Array.isArray(JSON.parse(snapshot!))).toBe(true);
  });

  it("pipeline 模式同样采集（snap 在 resolvePipeline 之前，两种模式都覆盖）", async () => {
    const exportDir = defaultExportDir();
    scratch.push(exportDir);
    // legacy 无 sink；这里只验证 beginBatch→snapshotCursors 对所有模式生效，
    // 用 legacy 之外的分支需要注入 sink/committer，改由 CLI 侧的端到端用例覆盖。
    const result = await ingestExport({ store, dir: exportDir, now: T1, only: ["张三"] });
    expect(store.staging.getBatch(result.batch_id)?.cursor_snapshot_json).not.toBeNull();
  });

  it("快照在批次开始前采集：预置游标被写入快照，revertBatch 后 restored > 0 且游标回退", async () => {
    // 预置一条游标（模拟上一次成功导入的落档位置）
    store.staging.advanceCursor({
      platform: "wechat",
      conversation_id: "wechat:wxid_aaaaaaaaaaaa22",
      last_ts_ms: 0,
      last_message_id: "seed",
      now: T1,
    });
    const exportDir = defaultExportDir();
    scratch.push(exportDir);
    const result = await ingestExport({ store, dir: exportDir, now: T1 });

    const snapshotJson = store.staging.getBatch(result.batch_id)?.cursor_snapshot_json;
    expect(snapshotJson).not.toBeNull();
    const snapshot = JSON.parse(snapshotJson!) as { conversation_id: string; last_ts_ms: number }[];
    expect(snapshot.length).toBeGreaterThan(0);

    // 落档会把游标推进到本批最大 ts_ms
    const before = store.staging.readCursor("wechat", "wechat:wxid_aaaaaaaaaaaa22");
    expect(before?.last_ts_ms).toBeGreaterThan(0);

    const revert = store.revertBatch({ batch_id: result.batch_id, now: T2 });
    expect(revert.restored).toBeGreaterThan(0); // 不再恒 0
    expect(revert.restored).toBe(snapshot.length);

    // 游标确实回退到快照值
    const after = store.staging.readCursor("wechat", "wechat:wxid_aaaaaaaaaaaa22");
    expect(after?.last_ts_ms).toBe(0);
    expect(after?.last_message_id).toBe("seed");
  });
});

/**
 * 批次 1 缺陷 2：改名 / 合并 / 归档之后**自动重算图谱快照**。
 *
 * 起因：主理人在真实数据上改名成功，切到图谱**还是旧名字**，重跑 `mining-run` 才变。
 * 根因是 `GET /graph` 读的是挖掘快照，label 在那时就写死了。
 *
 * 本文件钉三件事：
 *   A. 改名成功 → 回包带 `graph_refresh`，且**确实调了**挖掘器；
 *   B. 连续改两次（防抖窗口内）→ 只跑**一次**（15 万条那次全量挖掘要 15 秒，不能串着跑）；
 *   C. 只改备注（不动显示名）→ **不触发**（备注不进图谱，白跑一次没意义）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPersonStore, type PersonStore } from "@knowself/person-store";
import { dispatch } from "../src/routes/index.js";
import type { KnowselfServices } from "../src/services.js";
import {
  resetSchedulerForTest,
  setDebounceForTest,
  setMineRunnerForTest,
  waitForIdleForTest,
} from "../src/graph-refresh.js";

const BASE = "http://localhost/knowself-api";
const NOW = "2026-11-21T10:00:00.000Z";

let dir = "";
let store: PersonStore;
let mine: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetSchedulerForTest();
  // 生产是 5 秒；测试里调到 10ms，否则每个用例都要等一轮防抖
  setDebounceForTest(10);
  mine = vi.fn(async () => ({}));
  setMineRunnerForTest(mine);
  dir = mkdtempSync(join(tmpdir(), "knowself-graph-refresh-"));
  store = createPersonStore({ dbPath: join(dir, "persons.sqlite"), encryption: { mode: "none" } });
});

afterEach(async () => {
  await waitForIdleForTest(500);
  resetSchedulerForTest();
  setDebounceForTest(null);
  setMineRunnerForTest(null);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 发一条写请求。 */
async function call(method: string, path: string, body: unknown) {
  const services = { personStore: store } as unknown as KnowselfServices;
  return dispatch(new URL(`${BASE}/write${path}`), services, method, body);
}

describe("改名 / 合并 / 归档 → 自动重算快照", () => {
  it("A. 改名 → 回包带 graph_refresh，且挖掘器被调用一次", async () => {
    const person = store.persons.createManualPerson({ display_name: "旧名" }, NOW);
    const res = await call("PATCH", `/person/${person.person_id}`, { display_name: "新名" });

    expect(res.status).toBe(200);
    expect((res.body as { graph_refresh?: { scheduled: boolean } }).graph_refresh?.scheduled).toBe(true);

    await waitForIdleForTest();
    expect(mine).toHaveBeenCalledTimes(1);
    expect(mine).toHaveBeenCalledWith(store);
    // 名字确实改了（刷新不是唯一副作用）
    expect(store.persons.get(person.person_id)?.display_name).toBe("新名");
  });

  it("B. 防抖窗口内连改两次 → 只跑一次挖掘", async () => {
    const person = store.persons.createManualPerson({ display_name: "旧名" }, NOW);
    await call("PATCH", `/person/${person.person_id}`, { display_name: "名字一" });
    await call("PATCH", `/person/${person.person_id}`, { display_name: "名字二" });

    await waitForIdleForTest();
    expect(mine).toHaveBeenCalledTimes(1);
    expect(store.persons.get(person.person_id)?.display_name).toBe("名字二");
  });

  it("C. 只改备注 → 不触发挖掘（备注不进图谱）", async () => {
    const person = store.persons.createManualPerson({ display_name: "某人" }, NOW);
    const res = await call("PATCH", `/person/${person.person_id}`, { note: "实验室同学" });

    expect(res.status).toBe(200);
    expect((res.body as { graph_refresh?: unknown }).graph_refresh).toBeUndefined();
    await waitForIdleForTest();
    expect(mine).not.toHaveBeenCalled();
  });

  it("E. 挖掘抛错 → 写操作仍 200（刷新失败不算写失败）", async () => {
    mine.mockRejectedValueOnce(new Error("mining boom"));
    const person = store.persons.createManualPerson({ display_name: "旧名" }, NOW);
    const res = await call("PATCH", `/person/${person.person_id}`, { display_name: "新名" });
    expect(res.status).toBe(200);
    await waitForIdleForTest();
    expect(mine).toHaveBeenCalledTimes(1);
    // 名字改成功，刷新失败只影响图谱
    expect(store.persons.get(person.person_id)?.display_name).toBe("新名");
  });

  it("F. 两次写间隔 1 秒（< 5 秒窗口）→ 只触发一次挖掘", async () => {
    setDebounceForTest(5000); // 还原生产窗口
    const person = store.persons.createManualPerson({ display_name: "旧名" }, NOW);
    await call("PATCH", `/person/${person.person_id}`, { display_name: "名字一" });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await call("PATCH", `/person/${person.person_id}`, { display_name: "名字二" });
    await waitForIdleForTest(9000);
    expect(mine).toHaveBeenCalledTimes(1);
    expect(store.persons.get(person.person_id)?.display_name).toBe("名字二");
  }, 15000);

  it("D. 合并 → 也触发重算（节点集合会变）", async () => {
    const a = store.persons.createManualPerson({ display_name: "A" }, NOW).person_id;
    const b = store.persons.createManualPerson({ display_name: "B" }, NOW).person_id;
    const res = await call("POST", `/person/${a}/merge`, { target_person_id: b });

    expect(res.status).toBe(200);
    expect((res.body as { graph_refresh?: { scheduled: boolean } }).graph_refresh?.scheduled).toBe(true);
    await waitForIdleForTest();
    expect(mine).toHaveBeenCalledTimes(1);
  });
});

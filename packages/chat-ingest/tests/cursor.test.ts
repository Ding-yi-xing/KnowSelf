import { describe, expect, it } from "vitest";
import {
  advanceCursorState,
  CursorStore,
  IncrementalFilter,
  keep,
  maxCursorOf,
  type CursorRepoLike,
  type CursorState,
} from "../src/cursor";

const key = (ts_ms: number, message_id: string) => ({ ts_ms, message_id });

/** DESIGN-11 §5.2 过滤规则逐条。 */
describe("IncrementalFilter.keep（§5.2）", () => {
  it("无游标 → 全收（首采）", () => {
    expect(keep(key(1000, "a"), null)).toBe(true);
  });

  it("ts > last → 保留", () => {
    const cursor: CursorState = { last_ts_ms: 1000, last_message_id: "z" };
    expect(keep(key(1001, "a"), cursor)).toBe(true);
  });

  it("ts == last 且 id > last_id → 保留（同毫秒不丢）", () => {
    const cursor: CursorState = { last_ts_ms: 1000, last_message_id: "b" };
    expect(keep(key(1000, "c"), cursor)).toBe(true);
    expect(keep(key(1000, "b"), cursor)).toBe(false);
    expect(keep(key(1000, "a"), cursor)).toBe(false);
  });

  it("ts < last → 丢弃（回归数据不入库）", () => {
    const cursor: CursorState = { last_ts_ms: 1000, last_message_id: "a" };
    expect(keep(key(999, "zzz"), cursor)).toBe(false);
  });

  it("last_message_id 为 null 时同毫秒全收（宁可重复，不丢消息）", () => {
    const cursor: CursorState = { last_ts_ms: 1000, last_message_id: null };
    expect(keep(key(1000, "a"), cursor)).toBe(true);
  });

  it("批量过滤保持入参顺序", () => {
    const filter = new IncrementalFilter({ last_ts_ms: 1000, last_message_id: "b" });
    const kept = filter.filter([
      key(999, "x"),
      key(1000, "c"),
      key(1000, "a"),
      key(1001, "a"),
    ]);
    expect(kept).toEqual([key(1000, "c"), key(1001, "a")]);
  });
});

describe("maxCursorOf / advanceCursorState（§5.3 L3 单调不回退）", () => {
  it("取 (ts_ms, message_id) 字典序最大者", () => {
    expect(maxCursorOf([key(1000, "b"), key(1000, "c"), key(999, "z")])).toEqual({
      last_ts_ms: 1000,
      last_message_id: "c",
    });
    expect(maxCursorOf([])).toBeNull();
  });

  it("推进取 MAX；更小的一批静默不生效", () => {
    const current: CursorState = { last_ts_ms: 1000, last_message_id: "b" };
    expect(advanceCursorState(current, [key(1001, "a")])).toEqual({
      last_ts_ms: 1001,
      last_message_id: "a",
    });
    expect(advanceCursorState(current, [key(999, "zzz")])).toEqual(current);
    expect(advanceCursorState(null, [key(1000, "a")])).toEqual({
      last_ts_ms: 1000,
      last_message_id: "a",
    });
    expect(advanceCursorState(current, [])).toEqual(current);
  });

  it("同毫秒取更大的 message_id", () => {
    const current: CursorState = { last_ts_ms: 1000, last_message_id: "b" };
    expect(advanceCursorState(current, [key(1000, "a")])).toEqual(current);
    expect(advanceCursorState(current, [key(1000, "c")])).toEqual({
      last_ts_ms: 1000,
      last_message_id: "c",
    });
  });
});

/** 薄 store：只做读写委托，不参与事务（推进由调用方在落档后触发）。 */
describe("CursorStore（薄 store）", () => {
  function fakeRepo(): CursorRepoLike & { rows: Map<string, CursorState>; advances: number } {
    const rows = new Map<string, CursorState>();
    const repo = {
      rows,
      advances: 0,
      readCursor(platform: string, conversationId: string): CursorState | null {
        return rows.get(`${platform}|${conversationId}`) ?? null;
      },
      advanceCursor(q: {
        platform: string;
        conversation_id: string;
        last_ts_ms: number;
        last_message_id: string;
        now: string;
      }): void {
        repo.advances += 1;
        const prev = rows.get(`${q.platform}|${q.conversation_id}`) ?? null;
        const next = advanceCursorState(prev, [
          { ts_ms: q.last_ts_ms, message_id: q.last_message_id },
        ]);
        if (next !== null) rows.set(`${q.platform}|${q.conversation_id}`, next);
      },
    };
    return repo;
  }

  it("读游标 / 建过滤器 / 推进", () => {
    const repo = fakeRepo();
    const store = new CursorStore(repo);
    expect(store.read("wechat", "c1")).toBeNull();

    const advanced = store.advance("wechat", "c1", [key(1000, "a"), key(1000, "b")], "now");
    expect(advanced).toEqual({ last_ts_ms: 1000, last_message_id: "b" });
    expect(store.read("wechat", "c1")).toEqual({ last_ts_ms: 1000, last_message_id: "b" });

    const filter = store.filterFor("wechat", "c1");
    expect(filter.keep(key(1000, "a"))).toBe(false);
    expect(filter.keep(key(1001, "a"))).toBe(true);
  });

  it("重复推进同值不报错、不回退", () => {
    const repo = fakeRepo();
    const store = new CursorStore(repo);
    store.advance("wechat", "c1", [key(1000, "b")], "now");
    store.advance("wechat", "c1", [key(1000, "a")], "now");
    expect(store.read("wechat", "c1")).toEqual({ last_ts_ms: 1000, last_message_id: "b" });
  });
});

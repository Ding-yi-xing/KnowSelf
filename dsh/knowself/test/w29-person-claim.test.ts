// @vitest-environment node
/**
 * W29 B1：`POST /knowself-api/write/person/claim` 契约测试（真实临时 sqlite、合成数据）。
 *
 * 复用 `routes-crud.test.ts` 的建库口径（`encryption: none` 的临时库），直接调 `dispatch`：
 * 鉴权 / 写头守卫由 `web-bridge` / `write-bridge` 自己的测试锁定，本文件只验「路由 → 领域库」。
 *
 * 覆盖：
 *   A. 201：trim 后的名字、人工人物、alias 落库、`graph_refresh` 排队；
 *   B. 合成数据历史消息归属：插入 `sender_id = uid` 的消息，claim 后靠
 *      `v_chat_messages` 的 alias JOIN 自动解析到新 person（**不写任何迁移代码**）；
 *   C. 409 重复认领（按 `alias_already_claimed` 码）；
 *   D. 400 参数（sender_ref 前缀 / 空 uid / 空名 / 超 40 字）；
 *   E. 非写通道 / 非 POST → 404（护栏）；
 *   F. 人物层降级 → 503。
 *
 * 诚实限定：真实库 sender_id 多为 `name:` 形态，本用例用的是合成 `wxid_xxx`，
 * 只证明 JOIN 机制本身，不外推到真机数据分布。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPersonStore, type PersonStore } from "@knowself/person-store";
import { dispatch } from "../src/routes/index.js";
import { BadRequestError } from "../src/routes/http.js";
import type { KnowselfServices } from "../src/services.js";

// 避免 claim 成功后真的触发一次挖掘（本文件只验路由 + 落库；调度另由 graph-refresh.test.ts 覆盖）。
vi.mock("../src/graph-refresh.js", () => ({
  scheduleGraphRefresh: vi.fn(() => ({ scheduled: true, debounce_ms: 0 })),
}));

const BASE = "http://localhost/knowself-api";
const NOW = "2026-11-20T10:00:00.000Z";
const UID = "wxid_claim_target";

let dir = "";
let store: PersonStore;

/** `withStore=false` 模拟人物层降级（不能用默认参数，显式 undefined 会被默认值吃掉）。 */
function servicesOf(withStore = true): KnowselfServices {
  return { personStore: withStore ? store : undefined } as unknown as KnowselfServices;
}

/** 发起一次请求；`write=false` 时模拟不带 /write 的直调。 */
async function call(
  method: string,
  path: string,
  body?: unknown,
  write = true,
  services: KnowselfServices = servicesOf(),
): Promise<{ status: number; body: unknown }> {
  const url = new URL(`${BASE}${write ? "/write" : ""}${path}`);
  return dispatch(url, services, method, body);
}

/** 插入一条合成消息（sender_id 恰为待认领 uid）。 */
function seedMessage(messageId: string): void {
  // chat_messages 对 conversation_id 有外键，先建会话（与 routes-crud.test.ts 的 seedPair 一致）。
  store.conversations.upsertFromCommit(
    { conversation_id: `wechat:${UID}`, platform: "wechat", kind: "direct", title: "单聊" },
    NOW,
  );
  store.messages.insertOrIgnore([
    {
      message_id: messageId,
      conversation_id: `wechat:${UID}`,
      platform: "wechat",
      sender_id: UID,
      role: "other",
      ts_ms: 1_700_000_000_000,
      msg_date: "2026-11-20",
      content: "你好",
      content_type: "text",
      batch_id: "b-claim",
      ingested_at: NOW,
    },
  ]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "knowself-claim-"));
  store = createPersonStore({ dbPath: join(dir, "persons.sqlite"), encryption: { mode: "none" } });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("W29 B1：认领端点", () => {
  it("A. 201：trim 名字、建人工人物、alias 落库、graph_refresh 已排队", async () => {
    const res = await call("POST", "/person/claim", {
      sender_ref: `wechat:${UID}`,
      display_name: "  黄sir  ",
    });
    expect(res.status).toBe(201);
    const body = res.body as {
      person_id: string;
      display_name: string;
      alias: { platform: string; kind: string; alias: string };
      graph_refresh: { scheduled: boolean; debounce_ms: number };
    };
    expect(body.display_name).toBe("黄sir");
    expect(body.alias).toEqual({ platform: "wechat", kind: "platform_uid", alias: UID });
    expect(body.graph_refresh.scheduled).toBe(true);
    expect(store.persons.get(body.person_id)?.display_name).toBe("黄sir");
    expect(store.aliases.findByUid("wechat", UID)?.person_id).toBe(body.person_id);
  });

  it("B. 合成数据：sender_id = uid 的历史消息在 claim 后自动归属（视图 JOIN）", async () => {
    seedMessage("m-claim-1");
    // claim 前：没有别名 → 视图解析不出归属
    const before = store.persons.list().filter((p) => p.display_name === "黄sir");
    expect(before).toHaveLength(0);

    const res = await call("POST", "/person/claim", {
      sender_ref: `wechat:${UID}`,
      display_name: "黄sir",
    });
    expect(res.status).toBe(201);
    const personId = (res.body as { person_id: string }).person_id;
    expect(store.messages.list({ person_id: personId })).toHaveLength(1);
  });

  it("C. 409：同一 uid 重复认领 → alias_already_claimed，且不再建人", async () => {
    const first = await call("POST", "/person/claim", {
      sender_ref: `wechat:${UID}`,
      display_name: "黄sir",
    });
    expect(first.status).toBe(201);
    const second = await call("POST", "/person/claim", {
      sender_ref: `wechat:${UID}`,
      display_name: "另一个名字",
    });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: "alias_already_claimed",
      hint: "这个人已经被认领过了",
    });
    expect(store.persons.list().filter((p) => p.display_name === "另一个名字")).toHaveLength(0);
  });

  it("D. 400：sender_ref 前缀 / 空 uid / 空名 / 超 40 字", async () => {
    const badCases: Array<[string, unknown]> = [
      ["sender_ref 不以 wechat: 开头", { sender_ref: "name:黄sir", display_name: "黄sir" }],
      ["uid 为空", { sender_ref: "wechat:", display_name: "黄sir" }],
      ["display_name 为空", { sender_ref: `wechat:${UID}`, display_name: "   " }],
      ["display_name 超 40 字", { sender_ref: `wechat:${UID}`, display_name: "名".repeat(41) }],
      ["请求体不是对象", "not-an-object"],
    ];
    for (const [label, body] of badCases) {
      // 直调 dispatch 时 BadRequestError 会抛出（由 web-bridge 的 catch 统一转 400）。
      await expect(call("POST", "/person/claim", body, true), label).rejects.toThrow(
        BadRequestError,
      );
    }
  });

  it("E. 非写通道 / 非 POST → 404（写端点只认 handler 型通道）", async () => {
    const payload = { sender_ref: `wechat:${UID}`, display_name: "黄sir" };
    expect((await call("POST", "/person/claim", payload, false)).status).toBe(404);
    expect((await call("GET", "/person/claim", payload)).status).toBe(404);
    expect((await call("POST", "/person/other", payload)).status).toBe(404);
    expect(store.aliases.findByUid("wechat", UID)).toBeNull();
  });

  it("F. 人物层降级 → 503 + 与其它人物端点一致的降级体", async () => {
    const services = servicesOf(false);
    // 直调 handler 时 400 抛错由 bridge 收敛；这里用合法参数确保走到降级分支。
    const res = await call(
      "POST",
      "/person/claim",
      { sender_ref: `wechat:${UID}`, display_name: "黄sir" },
      true,
      services,
    );
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "degraded", layer: "person" });
  });
});

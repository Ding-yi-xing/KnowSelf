// @vitest-environment node
/**
 * W-3 批次 1：人物 / 资料 **CRUD 端点**的契约测试。
 *
 * ## 为什么直接调 `dispatch` 而不是走 web 桥
 * 本批新增的是"路由 + 领域库"这一段；鉴权、Origin、写头守卫已有
 * `web-bridge` / `write-bridge` 自己的测试锁定。直接调 `dispatch` 能用**真实 sqlite**
 * （临时库、`encryption: none`）验证归并语义——尤其是"别名一挪，历史消息自动改指向"，
 * 那是桩无法证明的部分。
 *
 * ## 覆盖
 *   A. `POST /persons`：201 建人（trim + manual_locked）；空名 400；**非写通道 404**（回归护栏）
 *   B. `PATCH /person/:id`：200 改名/改备注；空体 400；未知 404
 *   C. `POST /person/:id/merge`：200；别名迁移；源置 merged；**消息归属跟着走**；自合并 400；未知 404
 *   D. `DELETE /person/:id`：200 归档（`deleted:false`）；`me` 400；未知 404
 *   E. `PATCH /source/:id`：200 改名；空名 400；未知 404
 *   F. `DELETE /source/:id`：有已采纳提案 → 409；`?force=1` → 200
 *   G. `POST /proposal/:id/accept|reject`：200；未知 404；已决策 409
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPersonStore, type PersonStore } from "@knowself/person-store";
import { dispatch } from "../src/routes/index.js";
import type { KnowselfServices } from "../src/services.js";

const BASE = "http://localhost/knowself-api";
const NOW = "2026-11-20T10:00:00.000Z";

let dir = "";
let store: PersonStore;

/** 极简 profileStore 桩：只实现本批用到的四个方法。 */
function makeProfileStore(): {
  sources: {
    rows: Map<string, Record<string, unknown>>;
    get: (id: string) => Record<string, unknown>;
    rename: (id: string, name: string) => void;
    delete: (id: string) => void;
  };
  proposals: { listByStatus: (status: string) => Record<string, unknown>[] };
} {
  const rows = new Map<string, Record<string, unknown>>();
  rows.set("src-1", {
    id: "src-1",
    kind: "paste",
    original_name: "旧名字",
    mime_type: "text/plain",
    extracted_text: "x",
    truncated: false,
    char_count: 1,
    user_note: "",
    user_tags: [],
    status: "completed",
    metadata: {},
    created_at: NOW,
    last_ingested_at: null,
    last_error: null,
  });
  return {
    sources: {
      rows,
      get: (id) => {
        const row = rows.get(id);
        if (row === undefined) throw new Error("SourceNotFound");
        return row;
      },
      rename: (id, name) => {
        const row = rows.get(id);
        if (row !== undefined) row.original_name = name;
      },
      delete: (id) => {
        rows.delete(id);
      },
    },
    proposals: {
      listByStatus: (status) =>
        status === "accepted" ? [{ id: "prop-acc", source_id: "src-1", status }] : [],
    },
  };
}

/** 单条提案桩（accept/reject 用）。 */
function makeIngestion(
  acceptedStatus = "pending",
  target: Record<string, unknown> = { kind: "core" },
): {
  listProposalsByStatus: (status: string) => Record<string, unknown>[];
  acceptProposal: (id: string) => Record<string, unknown>;
  acceptSourceDistillProposal: (id: string) => Promise<Record<string, unknown>>;
  rejectProposal: (id: string) => Record<string, unknown>;
} {
  const proposal = { id: "prop-1", source_id: "src-1", status: acceptedStatus, target };
  return {
    listProposalsByStatus: (status) => (status === acceptedStatus ? [proposal] : []),
    acceptProposal: vi.fn((id: string) => ({ ...proposal, id, status: "accepted" })),
    acceptSourceDistillProposal: vi.fn(async (id: string) => ({ ...proposal, id, status: "accepted" })),
    rejectProposal: vi.fn((id: string) => ({ ...proposal, id, status: "rejected" })),
  };
}

/** 把服务桩转成 `KnowselfServices`（缺的层不提供，路由会走降级分支）。 */
function servicesOf(extra: Record<string, unknown> = {}): KnowselfServices {
  return { personStore: store, ...extra } as unknown as KnowselfServices;
}

/**
 * 发起一次写通道请求。
 * @param method 方法
 * @param path 逻辑路径（`/persons` 等，函数内部补 `/write`）
 * @param body 请求体
 * @param query 查询串
 */
async function call(
  method: string,
  path: string,
  body?: unknown,
  query = "",
): Promise<{ status: number; body: unknown }> {
  const url = new URL(`${BASE}/write${path}${query}`);
  return dispatch(url, servicesOf(), method, body);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "knowself-crud-"));
  store = createPersonStore({ dbPath: join(dir, "persons.sqlite"), encryption: { mode: "none" } });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("A. POST /persons", () => {
  it("201：建人、名字去空白、备注落 remark、manual_locked=true", async () => {
    const res = await call("POST", "/persons", { display_name: "  赵六  ", note: "实验室同学" });
    expect(res.status).toBe(201);
    const created = res.body as { person_id: string; display_name: string; remark: string; manual_locked: boolean };
    expect(created.display_name).toBe("赵六");
    expect(created.remark).toBe("实验室同学");
    expect(created.manual_locked).toBe(true);
    expect(store.persons.get(created.person_id)?.display_name).toBe("赵六");
  });

  it("400：空名字", async () => {
    await expect(call("POST", "/persons", { display_name: "   " })).rejects.toThrow(/不能为空/);
  });

  it("回归护栏：非写通道的 POST /persons 仍然 404", async () => {
    const res = await dispatch(new URL(`${BASE}/persons`), servicesOf(), "POST", {
      display_name: "赵六",
    });
    expect(res.status).toBe(404);
  });
});

describe("B. PATCH /person/:id", () => {
  it("200：改名 + 改备注，写后状态返回", async () => {
    const person = store.persons.createManualPerson({ display_name: "旧名" }, NOW);
    const res = await call("PATCH", `/person/${person.person_id}`, {
      display_name: "新名",
      note: "备注",
    });
    expect(res.status).toBe(200);
    expect((res.body as { display_name: string }).display_name).toBe("新名");
    expect(store.persons.get(person.person_id)?.remark).toBe("备注");
    expect(store.persons.get(person.person_id)?.manual_locked).toBe(true);
  });

  it("400：空体（两个字段都没给）", async () => {
    const person = store.persons.createManualPerson({ display_name: "旧名" }, NOW);
    await expect(call("PATCH", `/person/${person.person_id}`, {})).rejects.toThrow(/至少要提供/);
  });

  it("404：不存在的人物", async () => {
    const res = await call("PATCH", "/person/nope", { display_name: "x" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });
});

describe("C. POST /person/:id/merge", () => {
  /** 造一对人物：A 带一条平台别名与一条消息，B 为空。 */
  function seedPair(): { a: string; b: string } {
    const a = store.persons.createManualPerson({ display_name: "张三" }, NOW).person_id;
    const b = store.persons.createManualPerson({ display_name: "张三（备注名）" }, NOW).person_id;
    store.aliases.insert(
      {
        alias_id: "alias-a",
        person_id: a,
        platform: "wechat",
        alias_kind: "platform_uid",
        alias: "wxid_zhangsan",
        normalized: "wxid_zhangsan",
        source: "extractor",
      },
      NOW,
    );
    store.conversations.upsertFromCommit(
      { conversation_id: "wechat:c1", platform: "wechat", kind: "direct", title: "张三" },
      NOW,
    );
    store.messages.insertOrIgnore([
      {
        message_id: "m-merge-1",
        conversation_id: "wechat:c1",
        platform: "wechat",
        sender_id: "wxid_zhangsan",
        role: "other",
        ts_ms: 1_700_000_000_000,
        msg_date: "2026-11-20",
        content: "hi",
        content_type: "text",
        batch_id: "b1",
        ingested_at: NOW,
      },
    ]);
    return { a, b };
  }

  it("200：别名迁移 + 源标记 merged + 消息归属跟着走到目标", async () => {
    const { a, b } = seedPair();
    // 合并前：消息属于 A
    expect(store.messages.list({ person_id: a })).toHaveLength(1);
    expect(store.messages.list({ person_id: b })).toHaveLength(0);

    const res = await call("POST", `/person/${a}/merge`, { target_person_id: b, reason: "同一人" });
    expect(res.status).toBe(200);
    const result = res.body as { moved_aliases: number; from: { status: string; merged_into: string } };
    expect(result.moved_aliases).toBe(1);
    expect(result.from.status).toBe("merged");
    expect(result.from.merged_into).toBe(b);

    // 别名迁移
    expect(store.aliases.listByPerson(a)).toHaveLength(0);
    expect(store.aliases.listByPerson(b)).toHaveLength(1);
    // **消息跟着走**：没有逐行 UPDATE（chat_messages 有 append-only 触发器），靠视图 JOIN
    expect(store.messages.list({ person_id: a })).toHaveLength(0);
    expect(store.messages.list({ person_id: b })).toHaveLength(1);
  });

  it("chat-ingest 的伪别名 `name:<旧名>` 同样随 merge 迁移，消息跟着走", async () => {
    // 真实数据里 chat-ingest 的 sender_id 形如 `name:wxid_test_001`（`senderIdOf` 产出），
    // 落库时由 `ensurePersonForUid` 写成 `alias_kind='platform_uid'` 的别名行。
    // 视图 `v_chat_messages` 正是按 `(platform, 'platform_uid', alias = sender_id)` JOIN 的，
    // 所以「迁别名」= 迁消息，不需要任何特殊分支。
    const a = store.persons.createManualPerson({ display_name: "wxid_test_001" }, NOW).person_id;
    const b = store.persons.createManualPerson({ display_name: "真名" }, NOW).person_id;
    store.aliases.insert(
      {
        alias_id: "alias-pseudo",
        person_id: a,
        platform: "wechat",
        alias_kind: "platform_uid",
        alias: "name:wxid_test_001",
        normalized: "name:wxid_test_001",
        source: "extractor",
      },
      NOW,
    );
    store.conversations.upsertFromCommit(
      { conversation_id: "wechat:c2", platform: "wechat", kind: "direct", title: "某人" },
      NOW,
    );
    store.messages.insertOrIgnore([
      {
        message_id: "m-pseudo-1",
        conversation_id: "wechat:c2",
        platform: "wechat",
        sender_id: "name:wxid_test_001",
        role: "other",
        ts_ms: 1_700_000_100_000,
        msg_date: "2026-11-20",
        content: "hi",
        content_type: "text",
        batch_id: "b2",
        ingested_at: NOW,
      },
    ]);
    expect(store.messages.list({ person_id: a })).toHaveLength(1);

    const res = await call("POST", `/person/${a}/merge`, { target_person_id: b });
    expect(res.status).toBe(200);

    // ① 伪别名的 person_id 已指向目标
    expect(store.aliases.findByUid("wechat", "name:wxid_test_001")?.person_id).toBe(b);
    // ② 原消息出现在目标名下（视图 JOIN 生效）
    expect(store.messages.list({ person_id: a })).toHaveLength(0);
    expect(store.messages.list({ person_id: b })).toHaveLength(1);
  });

  it("400：合并到自己", async () => {
    const { a } = seedPair();
    const res = await call("POST", `/person/${a}/merge`, { target_person_id: a });
    expect(res.status).toBe(400);
    expect(String((res.body as { error: string }).error)).toContain("自己");
  });

  it("404：目标不存在", async () => {
    const { a } = seedPair();
    const res = await call("POST", `/person/${a}/merge`, { target_person_id: "nope" });
    expect(res.status).toBe(404);
  });
});

describe("D. DELETE /person/:id（归档）", () => {
  it("200：归档而不是物理删除（deleted:false, archived:true）", async () => {
    const person = store.persons.createManualPerson({ display_name: "临时" }, NOW);
    const res = await call("DELETE", `/person/${person.person_id}`, {});
    expect(res.status).toBe(200);
    const body = res.body as { status: string; deleted: boolean; archived: boolean };
    expect(body.status).toBe("archived");
    expect(body.deleted).toBe(false);
    expect(body.archived).toBe(true);
    // 行还在（只是归档）
    expect(store.persons.get(person.person_id)?.status).toBe("archived");
  });

  it("400：不能归档「我」；404：不存在", async () => {
    expect((await call("DELETE", "/person/me", {})).status).toBe(400);
    expect((await call("DELETE", "/person/nope", {})).status).toBe(404);
  });
});

describe("E/F. 资料改名与删除", () => {
  it("PATCH /source/:id → 200 改名（写后状态）", async () => {
    const profile = makeProfileStore();
    const url = new URL(`${BASE}/write/source/src-1`);
    const res = await dispatch(url, servicesOf({ profileStore: profile }), "PATCH", { name: "新名字" });
    expect(res.status).toBe(200);
    expect((res.body as { original_name: string }).original_name).toBe("新名字");
  });

  it("PATCH /source/:id → 400 空名 / 404 未知", async () => {
    const profile = makeProfileStore();
    await expect(
      dispatch(new URL(`${BASE}/write/source/src-1`), servicesOf({ profileStore: profile }), "PATCH", {
        name: "  ",
      }),
    ).rejects.toThrow(/不能为空/);
    const res = await dispatch(
      new URL(`${BASE}/write/source/nope`),
      servicesOf({ profileStore: profile }),
      "PATCH",
      { name: "x" },
    );
    expect(res.status).toBe(404);
  });

  it("DELETE /source/:id → 有已采纳提案时 409，force=1 才删", async () => {
    const profile = makeProfileStore();
    const guarded = await dispatch(
      new URL(`${BASE}/write/source/src-1`),
      servicesOf({ profileStore: profile }),
      "DELETE",
      {},
    );
    expect(guarded.status).toBe(409);
    expect((guarded.body as { error: string }).error).toBe("source_has_accepted_proposals");

    const forced = await dispatch(
      new URL(`${BASE}/write/source/src-1?force=1`),
      servicesOf({ profileStore: profile }),
      "DELETE",
      {},
    );
    expect(forced.status).toBe(200);
    expect((forced.body as { deleted: boolean }).deleted).toBe(true);
  });
});

describe("G. 单条提案 accept / reject", () => {
  it("200：accept 与 reject 分别调到领域库", async () => {
    const ingestion = makeIngestion();
    const accepted = await dispatch(
      new URL(`${BASE}/write/proposal/prop-1/accept`),
      servicesOf({ ingestion }),
      "POST",
      {},
    );
    expect(accepted.status).toBe(200);
    expect((accepted.body as { status: string }).status).toBe("accepted");
    const rejected = await dispatch(
      new URL(`${BASE}/write/proposal/prop-1/reject`),
      servicesOf({ ingestion }),
      "POST",
      {},
    );
    expect(rejected.status).toBe(200);
    expect((rejected.body as { status: string }).status).toBe("rejected");
  });

  it("404：不存在；409：已决策过", async () => {
    const ingestion = makeIngestion();
    const missing = await dispatch(
      new URL(`${BASE}/write/proposal/nope/accept`),
      servicesOf({ ingestion }),
      "POST",
      {},
    );
    expect(missing.status).toBe(404);

    const decided = makeIngestion("accepted");
    const again = await dispatch(
      new URL(`${BASE}/write/proposal/prop-1/accept`),
      servicesOf({ ingestion: decided }),
      "POST",
      {},
    );
    expect(again.status).toBe(409);
    expect((again.body as { error: string }).error).toBe("not_pending");
  });

  it("source_distill accept 走异步蒸馏入口；processing 不能重复决议", async () => {
    const ingestion = makeIngestion("pending", {
      kind: "source_distill",
      confidence: 0.4,
      classifier: "test",
      reason: "review",
    });
    const accepted = await dispatch(
      new URL(`${BASE}/write/proposal/prop-1/accept`),
      servicesOf({ ingestion }),
      "POST",
      {},
    );
    expect(accepted.status).toBe(200);
    expect(ingestion.acceptSourceDistillProposal).toHaveBeenCalledWith("prop-1");
    expect(ingestion.acceptProposal).not.toHaveBeenCalled();

    const processing = makeIngestion("processing", { kind: "source_distill" });
    const again = await dispatch(
      new URL(`${BASE}/write/proposal/prop-1/accept`),
      servicesOf({ ingestion: processing }),
      "POST",
      {},
    );
    expect(again).toMatchObject({ status: 409, body: { error: "not_pending", status: "processing" } });
  });
});

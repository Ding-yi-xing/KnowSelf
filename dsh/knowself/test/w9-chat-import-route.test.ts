/**
 * W-9 A1/A3：`chat-import` 与 `mining-run` 两条写端点的**装配与错误路径**测试。
 *
 * 这里刻意**不跑真实 chat-ingest**（那是 fixture/真机验收的事），而是注入 `ingest` / `mine`
 * 桩，锁住本文件自己的职责：参数校验、降级、404、装配顺序（先 source → 再 ingest → 再 mine）、
 * 以及「挖掘失败不回滚已导入消息」这条语义。
 *
 * 真实端到端（合成导出目录 → 真 REST → 真库 → 出边）在 W-9 验收里做，两者互补。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersonStore } from "@knowself/person-store";
import { importChat, runMining } from "../src/routes/chat-import.js";
import { BadRequestError } from "../src/routes/http.js";

/** 造一个真实存在的临时目录（`source_path` 必须是目录）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "w9-import-"));
  return dir;
}

/** 最小 services 桩。 */
function makeServices(opts: { withPerson?: boolean; withIngestion?: boolean; knownSource?: string } = {}) {
  const { withPerson = true, withIngestion = true, knownSource = "src-1" } = opts;
  const createSource = vi.fn(async () => ({ id: "src-new" }));
  const personStore = {
    listPersons: vi.fn(() => [{ person_id: "me" }, { person_id: "u1" }]),
    conversations: { list: vi.fn(() => []) },
    // 回包的 messages_committed 用 delta 计算，桩需要一个 count；
    // unattributed / backfill 各要一条计数（默认 0 = 全部可归因）
    messages: {
      count: vi.fn(() => 0),
      countUnattributed: vi.fn(() => 0),
      countBySenderId: vi.fn(() => 0),
    },
    aliases: { upsertExtractor: vi.fn() },
  };
  const services = {
    ...(withPerson ? { personStore } : {}),
    ...(withIngestion ? { ingestion: { createSource, listProposalsByStatus: () => [], acceptProposal: vi.fn() } } : {}),
    profileStore: {
      sources: {
        get: (id: string) => {
          if (id !== knownSource) throw new Error("not found");
          return { id };
        },
      },
      proposals: { insertMany: vi.fn() },
    },
  } as never;
  return { services, createSource, personStore };
}

/** 成功的 ingest 桩。 */
const ingestOk = (inserted = 60, ignored = 0) =>
  vi.fn(async () => ({
    batch_id: "b1",
    reader_id: "txt",
    conversation_count: 1,
    message_count: inserted,
    committed: inserted,
    skipped: ignored,
    tier: { auto: inserted, review: 0 },
  }));

/** 成功的 mine 桩。 */
const mineOk = (nodes = 4, edges = 6) =>
  vi.fn(async () => ({
    snapshotId: "snap-1",
    persons: 3,
    scopes: 1,
    upserted: 3,
    skippedLocked: 0,
    pruned: 0,
    warnings: [],
    intentsWritten: 0,
    graph: { snapshot: { nodes: new Array(nodes).fill({}), edges: new Array(edges).fill({}) }, warnings: [] },
  }));

describe("POST /write/chat-import（A1/A2）", () => {
  it("正常导入 → 建 source、调 ingest、自动挖掘，回包字段齐全", async () => {
    const dir = tempDir();
    const { services, createSource } = makeServices();
    const ingest = ingestOk(60, 0);
    const mine = mineOk();

    const result = await importChat(services, { source_path: dir }, { ingest: ingest as never, mine: mine as never });

    expect(result.status).toBe(200);
    expect(createSource).toHaveBeenCalledTimes(1); // 未给 source_id → 自动建一条 paste 载体
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(mine).toHaveBeenCalledTimes(1); // A2：导入后自动挖掘
    expect(result.body).toMatchObject({
      conversations: 1,
      messages: { parsed: 60, committed: 60, ignored: 0 },
      snapshot_id: "snap-1",
      nodes: 4,
      edges: 6,
    });
    const personsCreated = (result.body as { persons_created: number }).persons_created;
    expect(typeof personsCreated).toBe("number");
    rmSync(dir, { recursive: true, force: true });
  });

  it("给了已知 source_id → 不再新建 source", async () => {
    const dir = tempDir();
    const { services, createSource } = makeServices({ knownSource: "src-1" });
    const result = await importChat(services, { source_path: dir, source_id: "src-1" }, {
      ingest: ingestOk() as never,
      mine: mineOk() as never,
    });
    expect(result.status).toBe(200);
    expect(createSource).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it("未知 source_id → 404", async () => {
    const dir = tempDir();
    const { services } = makeServices({ knownSource: "src-1" });
    const result = await importChat(services, { source_path: dir, source_id: "nope" }, {
      ingest: ingestOk() as never,
      mine: mineOk() as never,
    });
    expect(result.status).toBe(404);
    rmSync(dir, { recursive: true, force: true });
  });

  it("两个字段都没给 → 400（不猜默认目录）", async () => {
    const { services } = makeServices();
    await expect(importChat(services, {}, { ingest: ingestOk() as never })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("source_path 不存在 → 400", async () => {
    const { services } = makeServices();
    await expect(
      importChat(services, { source_path: "C:/definitely/not/here" }, { ingest: ingestOk() as never }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("人物层降级 → 503 degraded(person)，且不调 ingest", async () => {
    const dir = tempDir();
    const { services } = makeServices({ withPerson: false });
    const ingest = ingestOk();
    const result = await importChat(services, { source_path: dir }, { ingest: ingest as never });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ status: "degraded", layer: "person" });
    expect(ingest).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it("挖掘失败 → 消息不回滚（ingest 已落），回包带 mining_warning 且 snapshot 为 null", async () => {
    const dir = tempDir();
    const { services } = makeServices();
    const mine = vi.fn(async () => {
      throw new Error("mining boom");
    });

    const result = await importChat(services, { source_path: dir }, {
      ingest: ingestOk(60, 0) as never,
      mine: mine as never,
    });

    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.messages).toEqual({ parsed: 60, committed: 60, ignored: 0, unattributed: 0 });
    expect(body.snapshot_id).toBeNull();
    expect(body.mining_warning).toContain("mining boom");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("A2：挖掘失败不回滚——**查库**断言，不只看回包", () => {
  it("ingest 真写了 3 条 → mining 抛错 → 库里仍有 3 条（派生失败不丢原始数据）", async () => {
    const dir = tempDir();
    const store = createPersonStore({ dbPath: ":memory:", encryption: { mode: "none" } });
    const now = "2026-11-12T00:00:00.000Z";

    // 真实的 ingest 桩：真的往库里写 3 条消息
    const ingest = vi.fn(async () => {
      store.conversations.upsertFromCommit(
        {
          conversation_id: "c1",
          platform: "other",
          kind: "group",
          title: "t",
          owner_person_id: "me",
          member_count: 2,
        },
        now,
      );
      store.messages.insertOrIgnore(
        [0, 1, 2].map((i) => ({
          message_id: `m${i}`,
          conversation_id: "c1",
          platform: "other" as const,
          sender_id: "u1",
          role: "other" as const,
          ts_ms: Date.parse(now) + i,
          msg_date: "2026-11-12",
          content: `c${i}`,
          content_type: "text" as const,
          reply_to: null,
          meta: "{}",
          batch_id: "b1",
          ingested_at: now,
        })),
      );
      return {
        batch_id: "b1",
        reader_id: "txt",
        conversation_count: 1,
        message_count: 3,
        committed: 3,
        skipped: 0,
        tier: { auto: 3, review: 0 },
      };
    });
    const mine = vi.fn(async () => {
      throw new Error("mining boom");
    });

    const { services } = makeServices();
    // 用**真库**替换桩里的 personStore
    (services as unknown as { personStore: unknown }).personStore = store;

    const result = await importChat(services, { source_path: dir }, {
      ingest: ingest as never,
      mine: mine as never,
    });

    expect(result.status).toBe(200);
    expect((result.body as Record<string, unknown>).mining_warning).toContain("mining boom");
    // ⬇️ 关键：不是只看回包，而是**真去库里数**
    expect(store.messages.count()).toBe(3);
    expect(store.conversations.list()).toHaveLength(1);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("auto_commit（W-9 C 决策：默认关、开启要留痕）", () => {
  /** 造一个会「产生 2 条 proposal」的 ingest 桩，并返回 accept 的 spy。 */
  function ingestWithProposals(services: unknown) {
    const acceptProposal = vi.fn();
    (services as { ingestion: { acceptProposal: unknown } }).ingestion.acceptProposal = acceptProposal;
    const ingest = vi.fn(async (args: { proposalSink: { create: (p: unknown) => void } }) => {
      args.proposalSink.create({ proposal_id: "p1" });
      args.proposalSink.create({ proposal_id: "p2" });
      return {
        batch_id: "b1",
        reader_id: "txt",
        conversation_count: 1,
        message_count: 80,
        committed: 0,
        skipped: 0,
        tier: { auto: 0, review: 2 },
      };
    });
    return { ingest, acceptProposal };
  }

  it("默认（不传 auto_commit）→ 不采纳任何 proposal，auto_committed=0", async () => {
    const dir = tempDir();
    const { services } = makeServices();
    const { ingest, acceptProposal } = ingestWithProposals(services);

    const result = await importChat(services, { source_path: dir }, {
      ingest: ingest as never,
      mine: mineOk() as never,
    });

    expect(acceptProposal).not.toHaveBeenCalled();
    expect((result.body as Record<string, unknown>).auto_committed).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("auto_commit=true 但没给 reason → 400（不许无声自动采纳）", async () => {
    const { services } = makeServices();
    await expect(
      importChat(services, { source_path: tempDir(), auto_commit: true }, { ingest: ingestOk() as never }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("auto_commit=true + reason → 采纳本次产生的 proposal，auto_committed=2，并打审计日志", async () => {
    const dir = tempDir();
    const { services } = makeServices();
    const { ingest, acceptProposal } = ingestWithProposals(services);
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((msg: unknown) => {
      logged.push(String(msg));
    });

    const result = await importChat(
      services,
      { source_path: dir, auto_commit: true, auto_commit_reason: "w9-acceptance" },
      { ingest: ingest as never, mine: mineOk() as never },
    );

    expect(acceptProposal).toHaveBeenCalledTimes(2);
    expect((result.body as Record<string, unknown>).auto_committed).toBe(2);
    const audit = logged.find((line) => line.includes("chat_import_auto_commit"));
    expect(audit).toBeDefined();
    expect(audit).toContain("w9-acceptance");

    spy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("POST /write/mining-run（A3）", () => {
  it("只跑挖掘、不导入，回包带快照与计数", async () => {
    const { services } = makeServices();
    const ingest = ingestOk();
    const mine = mineOk(5, 7);

    const result = await runMining(services, { ingest: ingest as never, mine: mine as never });

    expect(result.status).toBe(200);
    expect(ingest).not.toHaveBeenCalled();
    expect(mine).toHaveBeenCalledTimes(1);
    expect(result.body).toMatchObject({ snapshot_id: "snap-1", nodes: 5, edges: 7, persons: 3 });
  });

  it("人物层降级 → 503 degraded(person)", async () => {
    const { services } = makeServices({ withPerson: false });
    const result = await runMining(services, { mine: mineOk() as never });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ status: "degraded", layer: "person" });
  });
});

/**
 * W-9 补洞（主理人指出）：C 的 alias 是**导入时**建的。对「已导入过、之后只跑 mining-run」的库，
 * 没人再 import ⇒ alias 永远不存在 ⇒ 历史 `sender_id='me'` 的行永远解析不出 person。
 * 所以在 mining-run 里做一次幂等 backfill，并在这里锁住。
 */
describe("mining-run 的 self alias backfill（W-9 补洞）", () => {
  it("只有历史消息、没有任何 alias 时，跑一次 mining-run 后 me 的消息就能解析出来", async () => {
    const store = createPersonStore({ dbPath: ":memory:", encryption: { mode: "none" } });
    const now = "2026-11-12T00:00:00.000Z";

    // 直接落库模拟"修复前导入过的历史"：sender_id='me'，但没有 self alias
    store.conversations.upsertFromCommit(
      {
        conversation_id: "wechat:88888888888@chatroom",
        platform: "wechat",
        kind: "group",
        title: "历史群",
        owner_person_id: "me",
        member_count: 2,
      },
      now,
    );
    store.messages.insertOrIgnore([
      {
        message_id: "h1",
        conversation_id: "wechat:88888888888@chatroom",
        platform: "wechat" as const,
        sender_id: "me",
        role: "me" as const,
        ts_ms: Date.parse(now),
        msg_date: "2026-11-12",
        content: "历史里我发的一句话",
        content_type: "text" as const,
        reply_to: null,
        meta: "{}",
        batch_id: "b-history",
        ingested_at: now,
      },
    ]);

    // backfill 之前：解析不到 me（这正是真机上的现象）
    expect(store.messages.count({ person_id: "me" } as never)).toBe(0);

    const { services } = makeServices();
    (services as unknown as { personStore: unknown }).personStore = store;

    const result = await runMining(services, { mine: mineOk() as never });
    expect(result.status).toBe(200);

    // backfill 之后：同一批历史行立刻可解析（视图是查询期 JOIN，不需要重写消息）
    expect(store.messages.count({ person_id: "me" } as never)).toBeGreaterThan(0);
    // 幂等：再跑一次不会多出 alias 行
    await runMining(services, { mine: mineOk() as never });
    const selfAliases = store.aliases
      .listAll()
      .filter((a) => a.person_id === "me" && a.alias === "me");
    expect(selfAliases).toHaveLength(1);

    store.close();
  });

  /**
   * 静默 no-op 是这套代码里反复出现的坑（`filter(null)`、`?? ""`、`INSERT OR IGNORE`）：
   * 会话表为空却有 `sender_id='me'` 的消息时，backfill 什么也做不了——
   * 这时**必须喊出来**，不能装作「数据里本来就没有我」。
   */
  it("会话表为空但消息表里有 me 的消息 → 报 warning，不静默 no-op", async () => {
    const store = createPersonStore({ dbPath: ":memory:", encryption: { mode: "none" } });
    const now = "2026-11-12T00:00:00.000Z";

    // 会话表与消息表不一致：先插消息，再删掉会话（模拟历史脏数据 / 半途中断的导入）
    store.conversations.upsertFromCommit(
      {
        conversation_id: "wechat:77777777777@chatroom",
        platform: "wechat",
        kind: "group",
        title: "将消失的群",
        owner_person_id: "me",
        member_count: 2,
      },
      now,
    );
    store.messages.insertOrIgnore([
      {
        message_id: "orphan-1",
        conversation_id: "wechat:77777777777@chatroom",
        platform: "wechat" as const,
        sender_id: "me",
        role: "me" as const,
        ts_ms: Date.parse(now),
        msg_date: "2026-11-12",
        content: "孤儿消息",
        content_type: "text" as const,
        reply_to: null,
        meta: "{}",
        batch_id: "b-orphan",
        ingested_at: now,
      },
    ]);
    // 直接删会话表行（chat_messages 是 append-only，删不了；会话表没有该约束）
    // —— 用「会话列表返回空」模拟会话表已丢，而消息表里仍留着 me 的消息
    expect(store.conversations.list().length).toBe(1);
    (store.conversations as unknown as { list: () => unknown[] }).list = () => [];

    const { services } = makeServices();
    (services as unknown as { personStore: unknown }).personStore = store;

    expect(store.messages.countBySenderId("me")).toBe(1);
    const result = await runMining(services, { mine: mineOk() as never });
    expect(result.status).toBe(200);

    const warnings = (result.body as { warnings: string[] }).warnings;
    expect(warnings.some((w) => w.includes("会话表与消息表不一致"))).toBe(true);
    // 没有平台就无法补 alias → 不写任何 alias 行（也不假装写了）
    expect(store.aliases.listAll().filter((a) => a.alias === "me")).toHaveLength(0);

    store.close();
  });
});

/**
 * `messages.unattributed`（W-9 收口）：回执里的「其中 N 条无法识别发送者」。
 *
 * 计数必须**限定在本批**（不能把历史遗留的脏数据算到这次导入头上），
 * 且排除 `role='system'`（系统消息本就不该归属）。
 */
describe("导入回包的 messages.unattributed", () => {
  it("把 countUnattributed 的结果按本批 batch_id 报出来", async () => {
    const dir = tempDir();
    const { services, personStore } = makeServices();
    personStore.messages.countUnattributed = vi.fn(() => 3);

    const result = await importChat(services, { source_path: dir }, {
      ingest: ingestOk(60, 0) as never,
      mine: mineOk() as never,
    });

    expect(result.status).toBe(200);
    expect((result.body as { messages: { unattributed: number } }).messages.unattributed).toBe(3);
    // 必须带 batch_id：否则会把别的批次的遗留脏数据算进来
    expect(personStore.messages.countUnattributed).toHaveBeenCalledWith({ batch_id: "b1" });

    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * W-34-T02：平台闸。
 *
 * 为什么服务端必须有这道闸（不能只靠 UI 禁用按钮）：绕过 UI 直接 POST 时，
 * QQ/抖音 的导出目录会被微信解析器硬读，产出无法回溯的脏数据。
 * 为什么是 400 而不是 501：客户端把非 2xx 统一渲染成「导入失败：HTTP xxx」，
 * 501 会变成黑话；400 + 中文 error + 机器可读 code 才能让用户和调用方都看懂。
 */
describe("chat-import 平台闸（W-34-T02）", () => {
  it("老请求体不带 platform → 仍按微信解析，200 且 ingest 被调用", async () => {
    const dir = tempDir();
    const { services } = makeServices();
    const ingest = ingestOk(60, 0);

    const result = await importChat(services, { source_path: dir }, {
      ingest: ingest as never,
      mine: mineOk() as never,
    });

    expect(result.status).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("platform=wechat → 200，行为与不传完全一致", async () => {
    const dir = tempDir();
    const { services } = makeServices();
    const ingest = ingestOk(60, 0);

    const result = await importChat(services, { source_path: dir, platform: "wechat" }, {
      ingest: ingest as never,
      mine: mineOk() as never,
    });

    expect(result.status).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("platform=qq → 400 PLATFORM_NOT_SUPPORTED，且**不调 ingest**（不产生脏数据）", async () => {
    const dir = tempDir();
    const { services, createSource } = makeServices();
    const ingest = ingestOk();

    const result = await importChat(services, { source_path: dir, platform: "qq" }, {
      ingest: ingest as never,
      mine: mineOk() as never,
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: "PLATFORM_NOT_SUPPORTED" });
    expect((result.body as { error: string }).error).toContain("QQ");
    expect(ingest).not.toHaveBeenCalled();
    // 连载体资料都不该建（脏数据链路从第一步就断）
    expect(createSource).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it("platform=douyin → 400 PLATFORM_NOT_SUPPORTED，且不调 ingest", async () => {
    const dir = tempDir();
    const { services } = makeServices();
    const ingest = ingestOk();

    const result = await importChat(services, { source_path: dir, platform: "douyin" }, {
      ingest: ingest as never,
      mine: mineOk() as never,
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: "PLATFORM_NOT_SUPPORTED" });
    expect((result.body as { error: string }).error).toContain("抖音");
    expect(ingest).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it("platform 不在枚举内（telegram）→ 400 INVALID_PLATFORM，且不调 ingest", async () => {
    const dir = tempDir();
    const { services } = makeServices();
    const ingest = ingestOk();

    const result = await importChat(services, { source_path: dir, platform: "telegram" }, {
      ingest: ingest as never,
      mine: mineOk() as never,
    });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "不支持的平台", code: "INVALID_PLATFORM" });
    expect(ingest).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it("platform 非字符串（123）→ 400 INVALID_PLATFORM（类型错也归到同一个 code）", async () => {
    const dir = tempDir();
    const { services } = makeServices();
    const ingest = ingestOk();

    const result = await importChat(services, { source_path: dir, platform: 123 }, {
      ingest: ingest as never,
      mine: mineOk() as never,
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: "INVALID_PLATFORM" });
    expect(ingest).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });
});

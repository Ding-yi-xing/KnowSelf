/**
 * qa-2a-e2e-sink.test.ts — QA 独立验收（装配层端到端）：2A 差集去重 + scanLimit 告警。
 *
 * 与 `orchestrator-chat-proposal-sink.test.ts` 的区别：那个用假 store 验证单点逻辑，
 * 本文件全部走**真实 SQLite**（`profile.sqlite` 的 `ingestion_proposals` + `persons.sqlite`
 * 的 staging），并且：
 *   1. 显式传**两个不同的 `batch_id`**（两个合法 UUID），验证 conversation 作用域不会
 *      把上一轮的 pending 误判成「别的批次」；
 *   2. `scanLimit` 用真实 501 条 pending 触发，而不是让假 store 无视 limit 直接返回；
 *   3. 额外覆盖「非 chat 的 pending 会占用 scanLimit 预算」这一残留风险。
 *
 * 造数全部为合成内容（DESIGN-11 §9.1 铁律 2）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestionProposal } from "@knowself/contracts";
import { createProfileStore, type ProfileStore } from "@knowself/profile-store";
import { createPersonStore, type PersonStore } from "@knowself/person-store";
import {
  createChatMessageCommitter,
  ingestExport,
  type IngestExportResult,
} from "@knowself/chat-ingest";
import {
  createProfileProposalSink,
  type ProposalStoreLike,
} from "../src/orchestrator/chat-proposal-sink";

const NOW = "2026-11-06T10:00:00.000Z";
const SOURCE_ID = "00000000-0000-0000-0000-0000000000b2";
const CONV_KEY = "wxid_aaaaaaaaaaaab2";
const CONV = `wechat:${CONV_KEY}`;
const TS = new Date("2024-01-02T13:45:00+08:00").getTime();

/** 两次「CLI 运行」用的批次号：**都必须是合法 UUID**（contracts `batch_id: uuid()`）。 */
const BATCH_RUN1 = "10000000-0000-0000-0000-00000000000a";
const BATCH_RUN2 = "10000000-0000-0000-0000-00000000000b";
const BATCH_RUN3 = "10000000-0000-0000-0000-00000000000c";

/** 第 n 条合成消息（1-based）；显式 id → staging `message_id` = `<CONV>:s<n>`。 */
function syntheticMessage(n: number): Record<string, unknown> {
  return {
    message_id: `s${n}`,
    ts_ms: TS + n * 1000,
    sender_id: "name:张三",
    sender_name: "张三",
    role: "other",
    content: `第 ${n} 条合成消息`,
    content_type: "text",
  };
}

function mid(n: number): string {
  return `${CONV}:s${n}`;
}

/** 造一个含 `count` 条消息的 JSON 导出目录（前 count 条内容与其它 run 一致）。 */
function exportDir(count: number, scratch: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "knowself-qa-2a-export-"));
  scratch.push(dir);
  const messages: Record<string, unknown>[] = [];
  for (let n = 1; n <= count; n += 1) messages.push(syntheticMessage(n));
  writeFileSync(
    join(dir, "single.json"),
    JSON.stringify({
      conversation_key: CONV_KEY,
      title: "张三",
      kind: "单聊",
      messages,
    }),
    "utf8",
  );
  return dir;
}

// ──────────────────────────────────────────────────────────────────────────
//  真实 store 装配
// ──────────────────────────────────────────────────────────────────────────

let root: string;
let profileStore: ProfileStore;
let personStore: PersonStore;
let scratch: string[];

beforeEach(() => {
  scratch = [];
  root = mkdtempSync(join(tmpdir(), "knowself-qa-2a-"));
  scratch.push(root);
  profileStore = createProfileStore({
    dbPath: join(root, "profile.sqlite"),
    sourcesDir: join(root, "sources"),
    exportsDir: join(root, "exports"),
  });
  // ingestion_proposals.source_id 有 FK → 必须先有一条真实 source
  profileStore.sources.insert({
    id: SOURCE_ID,
    kind: "file",
    original_name: "chat-export",
    mime_type: "text/plain",
    file_path: null,
    url: null,
    extracted_text: "chat export",
    truncated: false,
    char_count: 11,
    user_note: "",
    user_tags: [],
    status: "pending_review",
    metadata: {},
    created_at: NOW,
    last_ingested_at: null,
    last_error: null,
  });
  personStore = createPersonStore({
    dbPath: join(root, "persons.sqlite"),
    encryption: { mode: "none" },
  });
});

afterEach(() => {
  profileStore.close();
  personStore.close();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** 一次「CLI 运行」：真实 sink + 真实 committer + 显式 batch_id。 */
async function runIngest(
  dir: string,
  batch_id: string,
  sinkOverrides: { scanLimit?: number } = {},
): Promise<IngestExportResult> {
  const sink = createProfileProposalSink({
    profileStore,
    acceptProposal: () => {
      // 本文件所有用例都应落在 Tier B（会话不存在 → NEW_CONVERSATION），不应自动 accept。
      throw new Error("Tier B 场景不应触发自动 accept");
    },
    ...sinkOverrides,
  });
  return ingestExport({
    store: personStore,
    dir,
    now: NOW,
    reader: "json",
    source_id: SOURCE_ID,
    proposalSink: sink,
    chatCommitter: createChatMessageCommitter(personStore),
    batch_id,
  });
}

function pendingProposals(): IngestionProposal[] {
  return profileStore.proposals.listByStatus("pending", 1000);
}

function chatProposalIds(proposal: IngestionProposal): string[] {
  const target = proposal.target as { message_ids?: string[] };
  return target.message_ids ?? [];
}

// ──────────────────────────────────────────────────────────────────────────
//  基线 1 / 2 / 风险 A：真实 DB + 两个不同 batch_id
// ──────────────────────────────────────────────────────────────────────────

describe("2A 装配层端到端 — 同一会话换 batch_id 重跑（风险 A）", () => {
  it("batch A 产生的 pending 在 batch B 里被认作同会话既有 pending（created 0）", async () => {
    const dir = exportDir(5, scratch);

    const first = await runIngest(dir, BATCH_RUN1);
    expect(first.mode).toBe("pipeline");
    expect(first.proposals.created).toBe(1);
    expect(first.proposals.queued).toBe(1);
    expect(first.proposals.accepted).toBe(0);
    expect(first.committed).toBe(0);
    expect(pendingProposals()).toHaveLength(1);

    // 关键：换一个**不同的合法 UUID** 当 batch_id 重跑同一目录
    const second = await runIngest(dir, BATCH_RUN2);
    expect(second.proposals.created).toBe(0);
    expect(second.proposals.queued).toBe(0);
    expect(second.proposals.reused).toBeGreaterThanOrEqual(1);
    expect(second.committed).toBe(0);
    // 队列里仍然只有 1 条覆盖 m1..m5 的 pending，没有产生重复条目
    expect(pendingProposals()).toHaveLength(1);
    expect(pendingProposals()[0]?.target).toMatchObject({ batch_id: BATCH_RUN1 });
    expect(chatProposalIds(pendingProposals()[0]!)).toHaveLength(5);
  });

  it("batch A {m1..m5} → batch B {m1..m6}：只新增 1 条、只含 m6", async () => {
    const first = await runIngest(exportDir(5, scratch), BATCH_RUN1);
    expect(first.proposals.created).toBe(1);

    const second = await runIngest(exportDir(6, scratch), BATCH_RUN2);
    expect(second.proposals.created).toBe(1);
    expect(second.proposals.queued).toBe(1);
    expect(second.proposals.reused).toBe(1);
    expect(second.proposals.skipped_messages).toBe(5);

    const pendings = pendingProposals();
    expect(pendings).toHaveLength(2);
    const run1Proposal = pendings.find((p) => p.target.kind === "chat_message" && (p.target as { batch_id: string }).batch_id === BATCH_RUN1);
    const run2Proposal = pendings.find((p) => p.target.kind === "chat_message" && (p.target as { batch_id: string }).batch_id === BATCH_RUN2);
    expect(run1Proposal).toBeDefined();
    expect(run2Proposal).toBeDefined();
    expect(chatProposalIds(run2Proposal!)).toEqual([mid(6)]);
    // 不存在覆盖 m1..m6 的 6 条重复条目
    for (const proposal of pendings) {
      expect(chatProposalIds(proposal)).not.toHaveLength(6);
    }
    // 覆盖无重复：两条 proposal 的并集恰好是 m1..m6
    const covered = pendings.flatMap((proposal) => chatProposalIds(proposal));
    expect(new Set(covered).size).toBe(6);
    expect([...covered].sort()).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => mid(n)).sort(),
    );
  });

  it("第三轮 batch C {m1..m7}：继续只补 m7（增量不会随运行次数退化）", async () => {
    await runIngest(exportDir(5, scratch), BATCH_RUN1);
    await runIngest(exportDir(6, scratch), BATCH_RUN2);

    const third = await runIngest(exportDir(7, scratch), BATCH_RUN3);
    expect(third.proposals.created).toBe(1);
    expect(third.proposals.reused).toBe(2);

    const pendings = pendingProposals();
    expect(pendings).toHaveLength(3);
    // createdAt 在本用例里是固定 NOW（三条同值，listByStatus 的排序此时不确定），
    // 故按 batch_id 定位「本轮新建的那条」。
    const latest = pendings.find(
      (item) =>
        item.target.kind === "chat_message" &&
        (item.target as { batch_id: string }).batch_id === BATCH_RUN3,
    );
    expect(latest).toBeDefined();
    expect(chatProposalIds(latest!)).toEqual([mid(7)]);
    const covered = pendings.flatMap((proposal) => chatProposalIds(proposal));
    expect(new Set(covered).size).toBe(7);
    expect(covered).toHaveLength(7);
  });

  it("Tier B 不落档 → 重复运行时该会话的新增消息只进一次队列（游标不推进的副作用被抵消）", async () => {
    const dir = exportDir(3, scratch);
    const first = await runIngest(dir, BATCH_RUN1);
    expect(first.committed).toBe(0);
    expect(personStore.messages.count({ conversation_id: CONV })).toBe(0);

    const second = await runIngest(dir, BATCH_RUN2);
    expect(second.committed).toBe(0);
    expect(second.proposals.created).toBe(0);
    expect(personStore.messages.count({ conversation_id: CONV })).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
//  基线 6：扫描上限必须告警（不静默降级）
//
//  验收时的口径已随工程师的 B 方案调整（原口径是「>500 条就告警」）：
//    - 扫描窗口 = min(队列实际规模, 硬上限 5000)，**不再固定 500**；
//    - 因此 500~5000 区间不再漏判，也就无需告警（旧口径的静默漏判被结构性消除）；
//    - 告警闸口 = 「真的漏判了」= 队列规模 **严格大于** 5000。
//  本组用例按**当前代码**验证「不静默」这一实质性要求，不断言具体阈值的历史形态。
// ──────────────────────────────────────────────────────────────────────────

function chatProposal(
  id: string,
  message_ids: string[],
  created_at: string,
  conversation_id = CONV,
): IngestionProposal {
  return {
    id,
    source_id: SOURCE_ID,
    target: {
      kind: "chat_message",
      batch_id: BATCH_RUN1,
      conversation_id,
      message_ids,
      tier: "review",
      reason_codes: ["ID_FALLBACK"],
    },
    proposed_body: "摘要",
    reasoning: "tier=review; rule_version=chat-tier-v1; reason_codes=[ID_FALLBACK]",
    source_excerpts: [],
    produced_by_provider: "chat-ingest:rule-v1",
    status: "pending",
    user_edited_body: null,
    created_at,
    decided_at: null,
  };
}

function cardProposal(id: string, created_at: string): IngestionProposal {
  return {
    id,
    source_id: SOURCE_ID,
    target: {
      kind: "card_section",
      card_key: "work",
      section: "s1",
    } as IngestionProposal["target"],
    proposed_body: "摘要",
    reasoning: "tier=auto; rule_version=chat-tier-v1; reason_codes=[]",
    source_excerpts: [],
    produced_by_provider: "chat-ingest:rule-v1",
    status: "pending",
    user_edited_body: null,
    created_at,
    decided_at: null,
  };
}

/** 递增 created_at，让 `listByStatus` 的「最新在前」顺序稳定。 */
function stamp(index: number): string {
  return new Date(Date.parse("2026-11-01T00:00:00.000Z") + index * 1000).toISOString();
}

/** 塞 `count` 条 chat pending（按会话 CONV）。 */
function seedChatPendings(count: number): void {
  const items: IngestionProposal[] = [];
  for (let index = 0; index < count; index += 1) {
    items.push(chatProposal(`p-${index}`, [`m-${index}`], stamp(index)));
  }
  profileStore.proposals.insertMany(items);
}

describe("基线 6 — 扫描上限触顶必须告警（真实 profile.sqlite）", () => {
  it("501 条积压（旧口径的告警线）→ 不再截断、不告警、全部扫到", () => {
    seedChatPendings(501);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const sink = createProfileProposalSink({ profileStore, acceptProposal: vi.fn() });
      const refs = sink.listPending({ conversation_id: CONV });

      expect(refs).toHaveLength(501);
      expect(warn).not.toHaveBeenCalled();
      expect(sink.drainWarnings?.() ?? []).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("5001 条 > 默认硬上限 5000 → console.warn 1 次 + drainWarnings 1 条（含精确数字）", () => {
    seedChatPendings(5001);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const sink = createProfileProposalSink({ profileStore, acceptProposal: vi.fn() });
      const refs = sink.listPending({ conversation_id: CONV });

      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0]?.[0] ?? "");
      expect(logged).toContain("5001");
      expect(logged).toContain("5000");
      expect(logged).toContain(CONV);

      const drained = sink.drainWarnings?.() ?? [];
      expect(drained).toHaveLength(1);
      expect(drained[0]).toContain("5001");
      expect(drained[0]).toContain("5000");

      // 窗口确实被截断（5000 < 5001）——正因如此告警必须存在
      expect(refs).toHaveLength(5000);
    } finally {
      warn.mockRestore();
    }
  });

  it("多个会话都触顶 → 只告警 1 次（日志不刷屏）且 drainWarnings 仍只 1 条", () => {
    seedChatPendings(3);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const sink = createProfileProposalSink({
        profileStore,
        acceptProposal: vi.fn(),
        scanLimit: 2,
      });
      sink.listPending({ conversation_id: "c-a" });
      sink.listPending({ conversation_id: "c-b" });
      sink.listPending({ conversation_id: "c-c" });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(sink.drainWarnings?.() ?? []).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("drainWarnings 取走即清空 → 第二轮取到空（不跨轮泄漏）", () => {
    seedChatPendings(3);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const sink = createProfileProposalSink({
        profileStore,
        acceptProposal: vi.fn(),
        scanLimit: 2,
      });
      sink.listPending({ conversation_id: CONV });
      expect(sink.drainWarnings?.() ?? []).toHaveLength(1);
      expect(sink.drainWarnings?.() ?? []).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("恰好等于上限（一条都没漏）→ 不告警（严格大于才算降级）", () => {
    seedChatPendings(3);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const sink = createProfileProposalSink({
        profileStore,
        acceptProposal: vi.fn(),
        scanLimit: 3,
      });
      expect(sink.listPending({ conversation_id: CONV })).toHaveLength(3);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("端到端：积压触顶时告警进 IngestExportResult.warnings（用户可见，不只 console）", async () => {
    // 2 条更新的 card pending 挤掉窗口内更旧的 chat pending（本会话）
    const items: IngestionProposal[] = [
      cardProposal("card-0", stamp(1)),
      cardProposal("card-1", stamp(2)),
      chatProposal("chat-old", [mid(1)], stamp(0)),
    ];
    profileStore.proposals.insertMany(items);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await runIngest(exportDir(2, scratch), BATCH_RUN1, { scanLimit: 2 });

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("2");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("残留风险：非 chat 的 pending 占用扫描预算 → 会漏判，靠 warnings 兜住而不是静默", async () => {
    const items: IngestionProposal[] = [
      cardProposal("card-0", stamp(1)),
      cardProposal("card-1", stamp(2)),
      chatProposal("chat-old", [mid(1)], stamp(0)),
    ];
    profileStore.proposals.insertMany(items);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const sink = createProfileProposalSink({
        profileStore,
        acceptProposal: vi.fn(),
        scanLimit: 2,
      });
      // 本会话的 chat pending 落在扫描窗口之外 → 漏判（会重复建 proposal）
      expect(sink.listPending({ conversation_id: CONV })).toEqual([]);
      // 但一定不静默
      expect(sink.drainWarnings?.() ?? []).toHaveLength(1);

      const result = await runIngest(exportDir(2, scratch), BATCH_RUN1, { scanLimit: 2 });
      expect(result.warnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("未触顶（499 < 5000）→ 不告警", () => {
    seedChatPendings(499);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const sink = createProfileProposalSink({ profileStore, acceptProposal: vi.fn() });
      expect(sink.listPending({ conversation_id: CONV })).toHaveLength(499);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

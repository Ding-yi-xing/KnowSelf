/**
 * 批 2b —— 撤销后强制复核的**完整链路**（评审定稿 11b / 11d / 11f）。
 *
 * 假撤销根因：1B′ 的 `trusted_ingest = 会话已存在 ∨ auto_ok`，而 `revertBatch`
 * 不删 `chat_conversations` ⇒ 撤销后 exists 仍 true ⇒ 重导直接 Tier A 自动落档。
 * 本用例走真实 ingestExport 管线证明：
 *   ① 撤销后 deriveTierConfig 注入 review ⇒ MANUAL_FLAG ⇒ Tier B、committed=0；
 *   ② 人工接受并实际落档一批（新消息 ingested_at > reverted_at）⇒ 粘性解除；
 *   ③ 解除后下一次导入恢复 Tier A 自动落档。
 * 并附一条装配可达性断言（防止「实现了却没在 CLI 注入」重演）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersonStore, type PersonStore } from "@knowself/person-store";
import {
  createChatMessageCommitter,
  ingestExport,
  type ChatIngestProposalDraft,
  type ChatMessageCommitterLike,
  type IngestExportResult,
  type IngestProposalSink,
  type IngestTierConfig,
  type PendingProposalRef,
} from "@knowself/chat-ingest";
import { deriveTierConfig } from "../src/cli/revert";

const CONV_KEY = "wxid_aaaaaaaaaaaa22";
const CONV = `wechat:${CONV_KEY}`;
const SOURCE_ID = "00000000-0000-0000-0000-0000000000e2";
const TS = new Date("2024-01-02T13:45:00+08:00").getTime();

// 单调递增的可注入 now；julianday 对 ISO-Z 与空格格式都能正确解析
const T_IMPORT1 = "2026-11-07T08:00:00.000Z";
const T_REVERT = "2026-11-07T09:00:00.000Z";
const T_IMPORT2 = "2026-11-07T10:00:00.000Z";
const T_ACCEPT = "2026-11-07T11:00:00.000Z";
const T_IMPORT3 = "2026-11-07T12:00:00.000Z";

const B1 = "20000000-0000-0000-0000-000000000001";
const B2 = "20000000-0000-0000-0000-000000000002";
const B3 = "20000000-0000-0000-0000-000000000003";

let root: string;
let store: PersonStore;
let scratch: string[];

/** 造一个含 count 条消息的 JSON 导出目录（显式 message_id，无 ID_FALLBACK）。 */
function exportDir(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), "knowself-revert2b-export-"));
  scratch.push(dir);
  const messages = Array.from({ length: count }, (_, i) => ({
    message_id: `s${i + 1}`,
    ts_ms: TS + (i + 1) * 1000,
    sender_id: "name:张三",
    sender_name: "张三",
    role: "other",
    content: `第 ${i + 1} 条合成消息`,
    content_type: "text",
  }));
  writeFileSync(
    join(dir, "single.json"),
    JSON.stringify({ conversation_key: CONV_KEY, title: "张三", kind: "单聊", messages }),
    "utf8",
  );
  return dir;
}

interface MemorySink extends IngestProposalSink {
  created: ChatIngestProposalDraft[];
  accepted: string[];
}

/** accept 走真实 committer（人工接受的等价路径），now 可注入以控制 ingested_at。 */
function memorySink(committer: ChatMessageCommitterLike, now: string): MemorySink {
  const created: ChatIngestProposalDraft[] = [];
  const accepted: string[] = [];
  const decided = new Set<string>();
  return {
    created,
    accepted,
    listPending(input: { conversation_id: string }): readonly PendingProposalRef[] {
      return created
        .filter((p) => !decided.has(p.id) && p.target.conversation_id === input.conversation_id)
        .map((p) => ({ proposal_id: p.id, message_ids: p.target.message_ids }));
    },
    create(proposal: ChatIngestProposalDraft): void {
      created.push(proposal);
    },
    accept(proposalId: string): void {
      const proposal = created.find((p) => p.id === proposalId);
      if (proposal === undefined) throw new Error(`proposal 不存在: ${proposalId}`);
      committer.commit({
        proposal_id: proposalId,
        source_id: proposal.source_id,
        target: proposal.target,
        now,
      });
      decided.add(proposalId);
      accepted.push(proposalId);
    },
  };
}

async function runImport(
  count: number,
  batchId: string,
  now: string,
  tierConfig: IngestTierConfig,
): Promise<{ result: IngestExportResult; sink: MemorySink }> {
  const committer = createChatMessageCommitter(store);
  const sink = memorySink(committer, now);
  const result = await ingestExport({
    store,
    dir: exportDir(count),
    now,
    reader: "json",
    source_id: SOURCE_ID,
    proposalSink: sink,
    chatCommitter: committer,
    tierConfig,
    batch_id: batchId,
    only: ["张三"],
  });
  return { result, sink };
}

beforeEach(() => {
  scratch = [];
  root = mkdtempSync(join(tmpdir(), "knowself-revert2b-e2e-"));
  scratch.push(root);
  store = createPersonStore({ dbPath: join(root, "persons.sqlite"), encryption: { mode: "none" } });
  // 发送者已解析，保证 Tier A 只受 review 注入影响
  store.ensurePersonForUid({
    platform: "wechat",
    platform_uid: "name:张三",
    display_name: "张三",
    now: T_IMPORT1,
  });
  // 预置一条游标，使 snapshotCursors 采集到非空快照（revertBatch 能回退）
  store.staging.advanceCursor({
    platform: "wechat",
    conversation_id: CONV,
    last_ts_ms: 0,
    last_message_id: "seed",
    now: T_IMPORT1,
  });
});

afterEach(() => {
  store.close();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("撤销后强制复核：收回预授权 → 人工落档后恢复自动处理", () => {
  it("Tier A → 撤销 → Tier B(MANUAL_FLAG, committed=0) → 人工落档 → Tier A", async () => {
    // ① 首次导入：Tier A 自动落档
    const first = await runImport(3, B1, T_IMPORT1, { auto_ok: [CONV] });
    expect(first.result.tier).toEqual({ auto: 1, review: 0 });
    expect(first.result.committed).toBe(3);
    expect(store.messages.count({ conversation_id: CONV })).toBe(3);

    // ② 回滚（游标快照接线后 restored > 0）
    const revert = store.revertBatch({ batch_id: B1, now: T_REVERT });
    expect(revert.restored).toBeGreaterThan(0);
    expect(store.messages.count({ conversation_id: CONV })).toBe(0);
    // chat_conversations 未被删除 ⇒ 若无强制复核，exists 仍 true ⇒ 假撤销
    expect(store.conversations.get(CONV)).not.toBeNull();
    expect(store.isReviewRequired(CONV)).toBe(true);

    // ③ 重导：装配层派生的 review 命中 MANUAL_FLAG ⇒ Tier B，零自动落档
    const derived = deriveTierConfig({ auto_ok: [CONV] }, store);
    expect(derived.review).toContain(CONV);
    const second = await runImport(4, B2, T_IMPORT2, derived);
    expect(second.result.tier).toEqual({ auto: 0, review: 1 });
    expect(second.result.committed).toBe(0);
    expect(second.sink.accepted).toHaveLength(0);
    expect(second.sink.created.length).toBeGreaterThan(0);
    expect(second.sink.created.every((p) => p.target.reason_codes.includes("MANUAL_FLAG"))).toBe(true);
    // 仍处复核（粘性）：没有新消息落档
    expect(store.isReviewRequired(CONV)).toBe(true);
    expect(deriveTierConfig({}, store).review).toContain(CONV);

    // ④ 人工接受并实际落档一批：新消息 ingested_at = T_ACCEPT > reverted_at
    const proposal = second.sink.created[0]!;
    const landed = createChatMessageCommitter(store).commit({
      proposal_id: proposal.id,
      source_id: proposal.source_id,
      target: proposal.target,
      now: T_ACCEPT,
    });
    expect(landed.committed).toBeGreaterThan(0);
    // 粘性解除：探针看到「晚于最近撤销」的落档
    expect(store.isReviewRequired(CONV)).toBe(false);
    expect(store.listReviewRequiredConversations()).toEqual([]);
    expect(deriveTierConfig({}, store).review).toEqual([]);

    // ⑤ 下一次导入恢复 Tier A 自动落档
    const third = await runImport(5, B3, T_IMPORT3, deriveTierConfig({ auto_ok: [CONV] }, store));
    expect(third.result.tier).toEqual({ auto: 1, review: 0 });
    expect(third.result.committed).toBeGreaterThan(0);
    expect(third.sink.accepted.length).toBeGreaterThan(0);
    expect(third.sink.created.every((p) => !p.target.reason_codes.includes("MANUAL_FLAG"))).toBe(true);
  });

  it("对照：撤销后若不注入 review，重导会被 trusted_ingest 判成 Tier A（假撤销）", async () => {
    const first = await runImport(3, B1, T_IMPORT1, { auto_ok: [CONV] });
    expect(first.result.tier.auto).toBe(1);
    store.revertBatch({ batch_id: B1, now: T_REVERT });

    // 不调用 deriveTierConfig（即修复前的装配层行为）
    const reimport = await runImport(3, B2, T_IMPORT2, { auto_ok: [CONV] });
    expect(reimport.result.tier).toEqual({ auto: 1, review: 0 });
    expect(reimport.sink.accepted.length).toBeGreaterThan(0);
    expect(reimport.sink.created.every((p) => !p.target.reason_codes.includes("MANUAL_FLAG"))).toBe(true);
  });

  it("装配可达性：CLI 导入路径确实调用 deriveTierConfig（防止实现了却没注入）", () => {
    const source = readFileSync(join(__dirname, "../src/cli/ingest-chat.ts"), "utf8");
    expect(source).toContain("deriveTierConfig(loadTierConfig(opts.rootDir), runtime.personStore)");
    expect(source).toContain("--revert");
    expect(source).toContain("buildChatIndex({ conversationIds })");
  });
});

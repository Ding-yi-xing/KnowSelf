/**
 * C1（W-9 整洁项）：**快照级**空 label 断言，防的是"纯函数测过了、产物仍然空"。
 *
 * ## 两条路，缺一不可
 * **A. 上游修好之后的正常形状**：真实 `display_name` / 真实 `title` → 快照里
 *    label 必须是名字/标题，**不得**出现 `未命名(`，也不得是 `wechat:` 开头的兜底值。
 *    这条是"修了上游，下游就不该再兜底"的回归门。
 * **B. 故意构造空串（直接写库，绕过 reader）**：兜底路径必须仍然生效。
 *    没有这条，修完上游就等于把兜底代码变成无人走过的死分支 —— 换一个上游
 *    （别的 reader、别的平台、手工导入）又会炸在 `GraphSnapshotSchema.min(1)`。
 *
 * ## 为什么断言对象是快照
 * `label-fallback.test.ts` 只测 `labelOf` / `nonEmptyLabel` 的返回值。真机那次事故
 * 恰恰是"两个兜底都写对了、单测全绿"，但群节点那处 `?? conversationId` 挡不住空串，
 * 整个挖掘被 schema 打挂（`too_small path:["nodes",4,"label"]`）。
 * 所以这里钉在 `result.graph.snapshot.nodes[].label` 上。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersonStore, type PersonStore } from "@knowself/person-store";
import { runMiningPipeline } from "../src/pipeline";

const NOW = "2026-11-12T10:00:00+08:00";
const T0 = 1_700_000_000_000;
const DIRECT = "wechat:conv-direct";
const ME_UID = "wxid_me";
const NORMAL_UID = "wxid_normal";
const GROUP = "wechat:12345678901@chatroom";

let dir = "";
let store: PersonStore;

/**
 * 造一套最小可用数据（直插库，不走 reader）。
 *
 * @param input.groupTitle 群会话标题（A 路给真名，B 路给空串）
 * @param input.blankNameUid 若给出，则额外造一个该 uid 的「空 display_name」人物
 * @returns 人物 id 与群会话 id
 */
function seed(input: { groupTitle: string; blankNameUid?: string }): {
  normalId: string;
  blankId: string | null;
  groupId: string;
} {
  const normalId = store.ensurePersonForUid({
    platform: "wechat",
    platform_uid: NORMAL_UID,
    display_name: "张三",
    now: NOW,
  }).person_id;
  const blankId =
    input.blankNameUid === undefined
      ? null
      : store.ensurePersonForUid({
          platform: "wechat",
          platform_uid: input.blankNameUid,
          display_name: "",
          now: NOW,
        }).person_id;

  store.aliases.insert(
    {
      alias_id: "alias-me-snapshot",
      person_id: "me",
      platform: "wechat",
      alias_kind: "platform_uid",
      alias: ME_UID,
      normalized: ME_UID,
      source: "manual",
    },
    NOW,
  );

  store.conversations.upsertFromCommit(
    { conversation_id: DIRECT, platform: "wechat", kind: "direct", title: "张三" },
    NOW,
  );
  store.conversations.upsertFromCommit(
    { conversation_id: GROUP, platform: "wechat", kind: "group", title: input.groupTitle },
    NOW,
  );

  const rows = [
    { id: "s-1", conv: DIRECT, uid: NORMAL_UID, role: "other" as const, ts: T0 },
    { id: "s-2", conv: DIRECT, uid: ME_UID, role: "me" as const, ts: T0 + 60_000 },
    { id: "s-4", conv: GROUP, uid: ME_UID, role: "me" as const, ts: T0 + 180_000 },
    { id: "s-5", conv: GROUP, uid: NORMAL_UID, role: "other" as const, ts: T0 + 240_000 },
  ];
  if (input.blankNameUid !== undefined) {
    rows.push({ id: "s-3", conv: GROUP, uid: input.blankNameUid, role: "other" as const, ts: T0 + 120_000 });
  }
  store.messages.insertOrIgnore(
    rows.map((row) => ({
      message_id: row.id,
      conversation_id: row.conv,
      platform: "wechat",
      sender_id: row.uid,
      role: row.role,
      ts_ms: row.ts,
      msg_date: "2023-11-14",
      content: "合成文案",
      content_type: "text",
      batch_id: "batch-label",
      ingested_at: NOW,
    })),
  );

  const memberships: { conversation_id: string; person_id: string }[] = [
    { conversation_id: DIRECT, person_id: normalId },
    { conversation_id: DIRECT, person_id: "me" },
    { conversation_id: GROUP, person_id: normalId },
    { conversation_id: GROUP, person_id: "me" },
  ];
  if (blankId !== null) memberships.push({ conversation_id: GROUP, person_id: blankId });
  for (const membership of memberships) {
    store.conversations.upsertMember({ ...membership, is_active: true }, NOW);
  }
  store.conversations.recomputeMemberStats(DIRECT, NOW);
  store.conversations.recomputeMemberStats(GROUP, NOW);

  return { normalId, blankId, groupId: GROUP };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "knowself-label-snapshot-"));
  store = createPersonStore({
    dbPath: join(dir, "persons.sqlite"),
    encryption: { mode: "none" },
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("A. 上游修好后的正常形状：快照 label 就是真名 / 真标题", () => {
  it("人物用 display_name、群用 title，且**不出现**任何兜底形态", async () => {
    seed({ groupTitle: "老同学群" });
    const result = await runMiningPipeline({ store, write: true });
    const nodes = result.graph?.snapshot.nodes ?? [];

    expect(nodes.length).toBeGreaterThanOrEqual(3);
    expect(nodes.some((node) => node.kind === "group")).toBe(true);
    expect(nodes.some((node) => node.kind === "person")).toBe(true);

    // 兜底形态一个都不许出现（这就是"上游修好了"的判据）
    for (const node of nodes) {
      expect(node.label).not.toMatch(/^未命名\(/);
      expect(node.label.startsWith("wechat:")).toBe(false);
      expect(node.label.trim()).not.toBe("");
    }
    expect(nodes.find((node) => node.kind === "group")?.label).toBe("老同学群");
    expect(nodes.some((node) => node.label === "张三")).toBe(true);
  });
});

describe("B. 兜底路径（直接写库造空串，绕过 reader）", () => {
  it("空 display_name + 空群标题 → 挖掘不炸，且 nodes[].label 全部非空", async () => {
    seed({ groupTitle: "", blankNameUid: "wxid_blank_name" });
    const result = await runMiningPipeline({ store, write: true });
    const nodes = result.graph?.snapshot.nodes ?? [];

    expect(nodes.length).toBeGreaterThanOrEqual(3);
    for (const node of nodes) {
      expect(node.label.length).toBeGreaterThanOrEqual(1);
      expect(node.label.trim()).not.toBe("");
    }
  });

  it("兜底名是「可辨认」的：空名人物带 id 前缀，空标题群退回 conversationId", async () => {
    const { groupId } = seed({ groupTitle: "", blankNameUid: "wxid_blank_name" });
    const result = await runMiningPipeline({ store, write: true });
    const nodes = result.graph?.snapshot.nodes ?? [];

    const blankPerson = nodes.find((node) => node.kind === "person" && node.label.startsWith("未命名("));
    expect(blankPerson).toBeDefined();
    expect(blankPerson?.label).toMatch(/^未命名\([0-9a-zA-Z-]{1,6}\)$/);
    expect(nodes.find((node) => node.kind === "group")?.label).toBe(groupId);
  });

  it("把空名补上后重跑 → 兜底不再触发（兜底不会「顺手改名」）", async () => {
    const { blankId } = seed({ groupTitle: "老同学群", blankNameUid: "wxid_blank_name" });
    expect(blankId).not.toBeNull();
    store.persons.updateManual(blankId as string, { display_name: "王五" }, NOW);
    const result = await runMiningPipeline({ store, write: true });
    const nodes = result.graph?.snapshot.nodes ?? [];
    expect(nodes.some((node) => node.label === "王五")).toBe(true);
    expect(nodes.some((node) => node.label.startsWith("未命名("))).toBe(false);
  });
});

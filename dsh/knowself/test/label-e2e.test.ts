/**
 * C1-**端到端**（W-9 整洁项）：txt → `ingestExport` → `commitStaged` → `runMiningPipeline`
 * → 快照 label。
 *
 * ## 为什么还要这一条
 * 另外两条 C1 用例锚的是「落库后的形状」（直接写库造空串 / 造真名），它们能证明
 * **下游兜底**与**快照断言**有效，但证明不了「上游不再产空串」——
 * 真机那次事故的链路是：`[10:00] : 正文`（无名行）→ `sender_name=""`
 * → `persons.display_name=""` → 群节点 label 空 → `GraphSnapshotSchema.min(1)` 打挂整个挖掘。
 *
 * 所以这条用例**只走真实管线**，不手工塞数据：
 *   1. 写一段 txt：头部**没有 `# 显示名`**、消息行里有**两条没有发送者名字的**；
 *   2. `ingestExport`（pipeline 模式）→ staging + proposal；
 *   3. `commitStaged` → 真正落 `chat_conversations` / `chat_messages`；
 *   4. `runMiningPipeline({ write: true })`；
 *   5. 断言快照里 label 全是可读文本：真名 / 会话键 / 显式的 `未知(sender=)` 标记，
 *      **不出现** `未命名(`（那是 mining 的下游兜底，说明上游又漏了）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// ⚠ 这里**故意**不走包名解析：`@knowself/*` 的 `main` 指向 `dist/`，
// 而根 `test` 脚本不预构建 —— 测 dist 会「改了 src 仍绿」（W-6/D、W-8/A4 的教训）。
// 直接吃 src，才能保证这条端到端用例盯的是刚改过的代码。
import { ingestExport } from "../../../packages/chat-ingest/src/index.js";
import { createChatMessageCommitter } from "../../../packages/chat-ingest/src/committer.js";
import { createPersonStore, type PersonStore } from "../../../packages/person-store/src/index.js";
import { runMiningPipeline } from "../../../packages/mining/src/pipeline.js";

const NOW = "2026-11-12T10:00:00+08:00";

/** 头部缺 `# 显示名`；两条消息行 `[hh:mm] : 正文` 没有发送者名字。 */
const TXT = [
  "# 会话对象 : 88888888888@chatroom",
  "# 类型 : 群聊",
  "#",
  "---------- 2026-11-14 ----------",
  "[10:00] : 没有发送者名字的一行",
  "[10:01] 我: 我在",
  "[10:02] 孙九: 收到",
  "[10:03] : 又一条没名字的",
  "[10:04] 吴十: 我也是",
].join("\r\n");

let workDir = "";
let store: PersonStore;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "knowself-label-e2e-"));
  store = createPersonStore({
    dbPath: join(workDir, "persons.sqlite"),
    encryption: { mode: "none" },
  });
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("C1 端到端：无名行 + 缺显示名 → 快照 label 仍可读", () => {
  it("走完整管线后，persons.display_name / conversations.title / 快照 label 都不是空串", async () => {
    // ① 把 fixture 落到磁盘（reader 只认目录）
    const exportDir = join(workDir, "export");
    mkdirSync(exportDir, { recursive: true });
    writeFileSync(join(exportDir, "群聊.txt"), TXT, "utf8");

    // ② 导入（pipeline 模式：只写 staging + proposal）
    const proposals: string[] = [];
    const result = await ingestExport({
      store,
      dir: exportDir,
      source_id: "src-e2e",
      proposalSink: {
        listPending: () => [],
        create: (draft: { id: string }) => proposals.push(draft.id),
        accept: () => undefined,
      } as never,
      chatCommitter: createChatMessageCommitter(store) as never,
    });
    expect(result.message_count).toBe(5);
    expect(proposals).toHaveLength(1);

    // ③ 落库（等价于用户点了「采纳」）
    const conversationId = "wechat:88888888888@chatroom";
    store.commitStaged({
      batch_id: result.batch_id,
      conversation_id: conversationId,
      proposal_id: proposals[0] as string,
      now: NOW,
    });
    expect(store.messages.count()).toBe(5);

    // ④ 上游修复点：落库后的两处"曾经是空串"的字段
    const names = store.listPersons().map((person) => person.display_name);
    expect(names).toContain("孙九");
    expect(names).toContain("吴十");
    // 无名行被改写成显式标记（不是空串）
    expect(names).toContain("未知(sender=)");
    for (const name of names) expect(name.trim()).not.toBe("");

    const title = store.conversations.get(conversationId)?.title ?? "";
    expect(title).toBe("88888888888@chatroom");

    // ⑤ 挖掘 + 快照断言
    const mined = await runMiningPipeline({ store, write: true });
    const nodes = mined.graph?.snapshot.nodes ?? [];
    expect(nodes.length).toBeGreaterThanOrEqual(3);

    const labels = nodes.map((node) => node.label);
    for (const label of labels) {
      expect(label.trim()).not.toBe("");
      // 关键：不出现 mining 的下游兜底 —— 出现就说明上游又在产空串
      expect(label).not.toMatch(/^未命名\(/);
    }
    expect(labels).toContain("孙九");
    expect(labels).toContain("吴十");
    expect(labels).toContain("88888888888@chatroom"); // 群节点 label = 标题（= 会话键）
    expect(labels).toContain("未知(sender=)"); // 无名行的显式标记，照常进图
  });
});

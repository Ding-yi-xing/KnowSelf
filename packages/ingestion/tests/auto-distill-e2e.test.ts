/**
 * End-to-end test: auto-distill with real DB & provider.
 * Tests the full chain: createSource → runDistill → proposals.
 *
 * ⚠️ 这是**真实 LLM 集成测试**，不是单元测试：
 *   - 读写仓库根目录的真实 `data/profile.sqlite` 与 `data/sources`
 *   - 依赖 `settings.json` 中配置的真实 provider（默认 `sensenova`）可联通
 *   - 上游返回形状变化时会时通时不通（历史浮动项）
 *
 * 默认**跳过**（否则 `npx vitest run` 在没有可用 provider 的机器上永远红）。
 * 手动运行：`KNOWSELF_REAL_LLM=1 npx vitest run packages/ingestion/tests/auto-distill-e2e.test.ts`
 */
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const rootDir = resolve(import.meta.dirname, "../../..");

describe.skipIf(!process.env.KNOWSELF_REAL_LLM)("auto-distill e2e（真实 LLM，需 KNOWSELF_REAL_LLM=1）", () => {
  let store: any;
  let ingestion: any;
  let providerAdapter: any;
  let sourceId: string;

  beforeAll(async () => {
    const { createProfileStore } = await import("@knowself/profile-store");
    const { createProviderAdapter } = await import("@knowself/provider-adapter");
    const { createIngestion } = await import("@knowself/ingestion");
    const { loadSettings } = await import("@knowself/config");

    const settings = loadSettings(rootDir);

    store = createProfileStore({
      dbPath: resolve(rootDir, "data", "profile.sqlite"),
      sourcesDir: resolve(rootDir, "data", "sources"),
      exportsDir: resolve(rootDir, "data", "exports"),
    });

    providerAdapter = createProviderAdapter({
      configs: settings.providers,
      toolRegistry: { getTool: () => null, listTools: () => [] },
    });
    await providerAdapter.init();

    ingestion = createIngestion({
      store,
      providerAdapter,
      toolRegistry: { getTool: () => null, listTools: () => [] },
      sourcesDir: resolve(rootDir, "data", "sources"),
      distillProviderId: settings.conversation.writeback_provider_id || "sensenova",
    });
  });

  afterAll(() => {
    store.close();
  });

  it("last_error column exists", async () => {
    // Create a source to verify DB columns are correct
    const src = await ingestion.createSource({
      kind: "paste",
      text: "col check",
      original_name: "col_check",
      user_note: "",
      user_tags: [],
    });
    expect(src.last_error).toBeNull();
    expect(src.status).toBe("raw");
  });

  it("creates source and runs distill", async () => {
    const src = await ingestion.createSource({
      kind: "paste",
      text: `[user] 你好，我叫小李，是一名全栈开发者，住在北京。请帮我建立一份个人画像。

[assistant] 你好小李！我来帮你逐步建立个人画像。从你提供的信息来看：

1. **基本信息**
   - 姓名：小李
   - 职业：全栈开发者
   - 所在地：北京

2. **技能标签**
   - 全栈开发
   - 前端开发
   - 后端开发`,
      original_name: "对话测试",
      user_note: "",
      user_tags: ["测试"],
    });

    sourceId = src.id;
    expect(src.id).toBeTruthy();
    expect(src.status).toBe("raw");
    expect(src.last_error).toBeNull();

    // Run distill with 300s timeout (provider may be slow, 120s per attempt × 2 attempts)
    const result = await Promise.race([
      ingestion.runDistill(src, {
        provider_id: "sensenova",
        focus_hints: ["个人信息"],
        max_proposals: 4,
      }),
      new Promise<any>((_, rej) =>
        setTimeout(() => rej(new Error("Distill timed out after 300s")), 300_000),
      ),
    ]);

    expect(result).toBeDefined();
    expect(result.source_id).toBe(sourceId);
    expect(Array.isArray(result.produced_proposal_ids)).toBe(true);

    // Verify source was updated
    const updated = store.sources.get(sourceId);
    expect(updated.status).toBe("pending_review");

    // Verify proposals exist
    const proposals = store.proposals.listBySource(sourceId);
    expect(proposals.length).toBeGreaterThan(0);
    proposals.forEach((p: any) => {
      expect(p.status).toBe("pending");
      expect(p.source_id).toBe(sourceId);
    });
  }, 120_000);
});

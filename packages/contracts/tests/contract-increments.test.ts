import { describe, it, expect } from "vitest";
import {
  ProposalTargetKindSchema,
  ProposalTargetSchema,
  ProposalTargetChatMessageSchema,
} from "../src/source";
import { DocSourceTypeSchema, RetrieveQuerySchema, RetrieverConfigSchema } from "../src/retrieval";
import { ChatOptionsSchema } from "../src/provider";
import {
  AutomationScheduleSchema,
  AutomationTaskConfigSchema,
  AutomationSectionSchema,
  AppSettingsSchema,
  PartialAppSettingsSchema,
} from "../src/settings";

describe("source.ts — ProposalTargetChatMessage（DESIGN-11 §7.2 #1/#2）", () => {
  const target = {
    kind: "chat_message",
    batch_id: "30000000-0000-0000-0000-000000000003",
    conversation_id: "wechat:c1",
    message_ids: ["wechat:c1:1"],
    tier: "auto",
  };

  it("ProposalTargetKindSchema 增 'chat_message'（3 → 4 值）", () => {
    expect(ProposalTargetKindSchema.options).toEqual([
      "core",
      "card_section",
      "journal",
      "chat_message",
    ]);
  });

  it("ProposalTargetChatMessageSchema 套用 reason_codes 默认 []", () => {
    expect(ProposalTargetChatMessageSchema.parse(target).reason_codes).toEqual([]);
    expect(
      ProposalTargetChatMessageSchema.safeParse({ ...target, batch_id: "not-uuid" }).success,
    ).toBe(false);
    expect(ProposalTargetChatMessageSchema.safeParse({ ...target, message_ids: [] }).success).toBe(
      false,
    );
  });

  it("ProposalTargetSchema（discriminatedUnion）接受 4 个分支且既有 3 分支不变", () => {
    expect(ProposalTargetSchema.parse(target).kind).toBe("chat_message");
    expect(ProposalTargetSchema.parse({ kind: "core" }).kind).toBe("core");
    expect(ProposalTargetSchema.parse({ kind: "journal", date: "2026-09-09" }).kind).toBe(
      "journal",
    );
    expect(
      ProposalTargetSchema.parse({ kind: "card_section", card_key: "identity", section: "bio" })
        .kind,
    ).toBe("card_section");
  });
});

describe("retrieval.ts — 加法式（D17 §2.2 M-5/M-6）与非加法式（N-1/N-6）", () => {
  it("DocSourceTypeSchema 增 'message'（3 → 4 值）", () => {
    expect(DocSourceTypeSchema.options).toEqual(["core", "card", "journal", "message"]);
  });

  it("RetrieveQuery.filter_sources 上限 3 → 4", () => {
    const four = ["core", "card", "journal", "message"] as const;
    expect(
      RetrieveQuerySchema.parse({ text: "q", filter_sources: [...four] }).filter_sources,
    ).toHaveLength(4);
    expect(
      RetrieveQuerySchema.safeParse({ text: "q", filter_sources: [...four, "core"] }).success,
    ).toBe(false);
  });

  it("RetrieverConfig.embedding_model_id 默认 qwen3-embedding:0.6b（非加法式，已授权）", () => {
    expect(RetrieverConfigSchema.parse({}).embedding_model_id).toBe("qwen3-embedding:0.6b");
  });

  it("RetrieverConfig.rerank_timeout_ms 默认 15,000 → 500（非加法式，已授权）", () => {
    expect(RetrieverConfigSchema.parse({}).rerank_timeout_ms).toBe(500);
    expect(RetrieverConfigSchema.safeParse({ rerank_timeout_ms: 500 }).success).toBe(true);
  });

  it("RetrieverConfig.rerank_timeout_ms 下界 100（必须 ≤ 默认值 500）", () => {
    expect(RetrieverConfigSchema.safeParse({ rerank_timeout_ms: 100 }).success).toBe(true);
    expect(RetrieverConfigSchema.safeParse({ rerank_timeout_ms: 99 }).success).toBe(false);
  });
});

describe("provider.ts — temperature 默认 0（D17 §2.3 N-4，已授权）", () => {
  it("省略 temperature 时解析为 0", () => {
    const parsed = ChatOptionsSchema.parse({
      provider_id: "p1",
      messages: [{ role: "user", content: [] }],
    });
    expect(parsed.temperature).toBe(0);
  });

  it("显式传入的 temperature 仍生效（域 0–2）", () => {
    const parsed = ChatOptionsSchema.parse({
      provider_id: "p1",
      messages: [{ role: "user", content: [] }],
      temperature: 1.5,
    });
    expect(parsed.temperature).toBe(1.5);
    expect(
      ChatOptionsSchema.safeParse({
        provider_id: "p1",
        messages: [{ role: "user", content: [] }],
        temperature: 3,
      }).success,
    ).toBe(false);
  });
});

describe("settings.ts — Automation 增量（D17 §2.2 M-7）", () => {
  it("AutomationScheduleSchema 默认 6h / 09:00 / 周一 / 1 号", () => {
    const s = AutomationScheduleSchema.parse({ kind: "interval" });
    expect(s.interval_ms).toBe(21_600_000);
    expect(s.at_hhmm).toBe("09:00");
    expect(s.weekday).toBe(1);
    expect(s.day_of_month).toBe(1);
    expect(AutomationScheduleSchema.safeParse({ kind: "cron" }).success).toBe(false);
  });

  it("AutomationTaskConfigSchema 默认关闭 + dry_run（FR-10.5）", () => {
    const t = AutomationTaskConfigSchema.parse({ task_id: "ingest", schedule: { kind: "daily" } });
    expect(t.enabled).toBe(false);
    expect(t.dry_run).toBe(true);
    expect(t.catch_up).toBe(true);
    expect(t.max_runtime_ms).toBe(1_800_000);
    expect(t.options.semantic_l1).toBe(false);
    expect(t.options.max_llm_calls).toBe(200);
    expect(
      AutomationTaskConfigSchema.safeParse({ task_id: "unknown", schedule: { kind: "daily" } })
        .success,
    ).toBe(false);
  });

  it("AutomationSectionSchema 默认全关 + 全局 dry-run", () => {
    const a = AutomationSectionSchema.parse({});
    expect(a.enabled).toBe(false);
    expect(a.dry_run).toBe(true);
    expect(a.tick_ms).toBe(60_000);
    expect(a.tasks).toEqual([]);
    expect(a.report_push_dir).toBe("");
    expect(a.notify).toEqual({ badge: true, os_notification: false });
  });

  it("PartialAppSettingsSchema.automation 加法式补齐（PATCH 可改自动化配置）", () => {
    const parsed = PartialAppSettingsSchema.parse({ automation: { enabled: true } });
    expect(parsed.automation?.enabled).toBe(true);
    /** 缺省键不注入默认值（PATCH 语义：只改传了的键）。 */
    expect(parsed.automation?.dry_run).toBeUndefined();
    expect(PartialAppSettingsSchema.safeParse({ automation: { tick_ms: 1 } }).success).toBe(false);
  });

  it("AppSettingsSchema.automation 可选（缺省 = 不启用任何任务）", () => {
    expect(AppSettingsSchema.shape.automation.isOptional()).toBe(true);
    expect(
      AppSettingsSchema.safeParse({
        schema_version: 1,
        app: { feature_flags: {} },
        conversation: {},
        providers: [],
        mcp_servers: [],
        tool_defaults: {},
        retrieval: {},
        storage: {},
      }).success,
    ).toBe(true);
  });
});

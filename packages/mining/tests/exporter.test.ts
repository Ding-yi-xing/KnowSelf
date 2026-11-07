/**
 * Exporter 测试（DESIGN-12 §7.1~§7.4 + §12 P1-7 验收「导出可独立阅读」）。
 * 全部合成数据（人名只用 张三 / 李四 / 王五），无真实聊天内容。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MiningMessageRow } from "@knowself/person-store";
import { buildGraphSnapshot } from "../src/graph";
import { scorePersons } from "../src/value-scorer";
import {
  DEFAULT_EXPORT_PRODUCED_BY,
  buildExport,
  writeExport,
  type ExportInput,
  type ExportMetricRow,
} from "../src/exporter";

const T0 = 1_700_000_000_000;
let counter = 0;

function msg(conversationId: string, senderPersonId: string, tsMs: number): MiningMessageRow {
  counter += 1;
  return {
    message_id: `m-${counter}`,
    conversation_id: conversationId,
    platform: "wechat",
    role: senderPersonId === "me" ? "me" : "other",
    sender_id: `uid-${senderPersonId}`,
    sender_person_id: senderPersonId,
    ts_ms: tsMs,
    msg_date: "2023-11-14",
    content: "合成文案-不应出现在导出里",
    content_type: "text",
    reply_to: null,
    meta: "{}",
  };
}

const CONV = "wechat:conv-1";

function fixtureInput(overrides: Partial<ExportInput> = {}): ExportInput {
  const persons = [
    { person_id: "person-zhangsan", display_name: "张三" },
    { person_id: "person-lisi", display_name: "李四" },
    { person_id: "person-wangwu", display_name: "王五" },
  ];
  const messages = new Map([
    [
      CONV,
      [
        msg(CONV, "person-zhangsan", T0),
        msg(CONV, "person-lisi", T0 + 1_000),
        msg(CONV, "person-zhangsan", T0 + 2_000),
        msg(CONV, "person-wangwu", T0 + 3_000),
      ],
    ],
  ]);
  const graph = buildGraphSnapshot({
    // 图谱层用 `label`（§8.2 展示名），导出层用 `display_name`——此处做映射
    persons: persons.map((p) => ({ person_id: p.person_id, label: p.display_name })),
    groups: [],
    messagesByConversation: messages,
  }).snapshot;
  const ranking = scorePersons({
    persons: [
      {
        person_id: "person-zhangsan",
        msgCountOther90d: 2,
        daysSinceLastMsg: 1,
        initiativeRatioOther: 0.5,
        replyLatencyP50Ms: 60_000,
        msgCountMe: 2,
        msgCountOther: 2,
        avgSessionMsgs90d: 4,
        intentDist: { business: 2, social: 1 },
        degree: 2,
      },
      {
        person_id: "person-lisi",
        msgCountOther90d: 1,
        daysSinceLastMsg: 5,
        initiativeRatioOther: 0.5,
        replyLatencyP50Ms: 120_000,
        msgCountMe: 1,
        msgCountOther: 1,
        avgSessionMsgs90d: 4,
        intentDist: { social: 1 },
        degree: 1,
      },
    ],
  }).scored;
  const metrics: ExportMetricRow[] = [
    {
      person_id: "person-zhangsan",
      display_name: "张三",
      metric_key: "msg_count_other",
      metric_value: 2,
      metric_value_json: null,
      scope_kind: "global",
      scope_id: "",
      period: "all",
      period_key: "",
    },
    {
      person_id: "person-lisi",
      display_name: "李四",
      metric_key: "msg_count_other",
      metric_value: 1,
      metric_value_json: null,
      scope_kind: "global",
      scope_id: "",
      period: "all",
      period_key: "",
    },
    {
      person_id: "person-zhangsan",
      display_name: "张三",
      metric_key: "intent_dist",
      metric_value: null,
      metric_value_json: JSON.stringify({ business: 2, social: 1, other: 1 }),
      scope_kind: "global",
      scope_id: "",
      period: "all",
      period_key: "",
    },
  ];
  return {
    exportKind: "weekly",
    generatedAt: "2026-09-22T10:00:00+08:00",
    dataRange: { from: "2026-09-15", to: "2026-09-21" },
    counts: { messages: 4, persons: 3, conversations: 1 },
    warnings: ["intent_other_ratio=0.25"],
    persons,
    groups: [{ conversation_id: CONV, display_name: "老同学群" }],
    metrics,
    ranking,
    graph,
    quality: { unresolved_senders: 1, reverted_batches: 2 },
    topN: 5,
    ...overrides,
  };
}

describe("buildExport（§7.1 三形态文件集）", () => {
  it("产出 report.md / data.json / index.md / persons/*.md / groups/*.md / graph/communities.md", () => {
    const artifacts = buildExport(fixtureInput());
    const paths = [...artifacts.files.keys()].sort();
    expect(paths).toEqual(
      [
        "data.json",
        "graph/communities.md",
        "groups/wechat_conv-1.md", // 文件名净化：`:` → `_`（Windows 兼容）
        "index.md",
        "persons/person-lisi.md",
        "persons/person-zhangsan.md",
        "report.md",
      ].sort(),
    );
  });

  it("JSON 信封逐字段对齐 §7.2", () => {
    const artifacts = buildExport(fixtureInput({ exportKind: "graph" }));
    const parsed = JSON.parse(String(artifacts.files.get("data.json"))) as {
      envelope: Record<string, unknown>;
      metrics: unknown[];
      ranking: unknown[];
      graph: { nodes: unknown[] } | null;
    };
    const envelope = parsed.envelope;
    expect(envelope.schema_version).toBe("1");
    expect(envelope.export_kind).toBe("graph");
    expect(envelope.generated_at).toBe("2026-09-22T10:00:00+08:00");
    expect(envelope.produced_by).toBe(DEFAULT_EXPORT_PRODUCED_BY);
    expect(envelope.data_range).toEqual({ from: "2026-09-15", to: "2026-09-21" });
    expect(envelope.scope).toEqual({ scope_kind: "global", scope_id: "" });
    expect(envelope.counts).toEqual({ messages: 4, persons: 3, conversations: 1 });
    expect(envelope.warnings).toEqual(["intent_other_ratio=0.25"]);
    expect(parsed.metrics).toHaveLength(3);
    expect(parsed.ranking).toHaveLength(2);
    expect(parsed.graph?.nodes.length).toBeGreaterThan(0);
  });

  it("共同要求：每个文件头含生成时间 / 数据范围 / produced_by / 数据条数 / 口径声明 / 已知缺口", () => {
    const artifacts = buildExport(fixtureInput());
    for (const [path, content] of artifacts.files) {
      expect(content, path).toContain("2026-09-22T10:00:00+08:00");
      expect(content, path).toContain("2026-09-15");
      expect(content, path).toContain(DEFAULT_EXPORT_PRODUCED_BY);
      expect(content, path).toContain("口径声明");
      expect(content, path).toContain("已知缺口");
    }
    expect(artifacts.files.get("report.md")).toContain("消息条数");
    expect(artifacts.files.get("index.md")).toContain("数据条数");
  });

  it("不出现内部 id 作为唯一标识：文档形态带 display_name", () => {
    const artifacts = buildExport(fixtureInput());
    const report = String(artifacts.files.get("report.md"));
    expect(report).toContain("张三");
    const person = String(artifacts.files.get("persons/person-zhangsan.md"));
    expect(person).toContain("张三");
    const index = String(artifacts.files.get("index.md"));
    expect(index).toContain("老同学群");
  });

  it("display_name 缺失 → 回退 person_id 并记 warning（不猜）", () => {
    const input = fixtureInput();
    const artifacts = buildExport({
      ...input,
      metrics: [
        ...(input.metrics ?? []),
        {
          person_id: "person-unknown",
          display_name: "",
          metric_key: "msg_count_other",
          metric_value: 9,
          metric_value_json: null,
          scope_kind: "global",
          scope_id: "",
          period: "all",
          period_key: "",
        },
      ],
    });
    expect(artifacts.warnings.some((w) => w.startsWith("display_name_missing"))).toBe(true);
  });

  it("§7.4：默认不含消息正文（导出输入类型里没有正文字段）", () => {
    const artifacts = buildExport(fixtureInput());
    for (const [path, content] of artifacts.files) {
      expect(content, path).not.toContain("合成文案-不应出现在导出里");
    }
    expect(String(artifacts.files.get("data.json"))).not.toContain('"content"');
  });

  it("报告骨架含 §7.3 的 6 节", () => {
    const report = String(buildExport(fixtureInput()).files.get("report.md"));
    expect(report).toContain("# 周报 · 2026-09-21");
    expect(report).toContain("## 1. 总览");
    expect(report).toContain("## 2. 互动变化 Top 10 / Bottom 10");
    expect(report).toContain("## 3. 话题与意图分布");
    expect(report).toContain("## 4. 小圈子（社区）");
    expect(report).toContain("## 5. 价值 Top");
    expect(report).toContain("## 6. 数据质量与已知缺口");
  });

  it("数据质量节包含未解析发送者 / 已回滚批次 / warnings", () => {
    const report = String(buildExport(fixtureInput()).files.get("report.md"));
    expect(report).toContain("未解析发送者：1");
    expect(report).toContain("已回滚批次：2");
    expect(report).toContain("intent_other_ratio=0.25");
  });
});

describe("writeExport（§7.4 落盘）", () => {
  it("把文件集写入目标目录并返回相对路径清单", () => {
    const dir = mkdtempSync(join(tmpdir(), "knowself-export-"));
    try {
      const artifacts = buildExport(fixtureInput());
      const written = writeExport(dir, artifacts);
      expect(written).toContain("report.md");
      expect(existsSync(join(dir, "report.md"))).toBe(true);
      expect(existsSync(join(dir, "persons", "person-zhangsan.md"))).toBe(true);
      expect(readFileSync(join(dir, "index.md"), "utf8")).toContain("2026-09-22T10:00:00+08:00");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

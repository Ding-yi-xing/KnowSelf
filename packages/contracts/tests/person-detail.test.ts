import { describe, it, expect } from "vitest";
import {
  PersonDetailSchema,
  PersonPatchSchema,
  RelationshipPatchSchema,
  EventWriteRequestSchema,
  SentimentTrendPointSchema,
  TraceRowSchema,
} from "../src/person-detail";

const iso = "2026-09-09T20:00:00+08:00";

const sentimentPoint = {
  period: "2026-W36",
  score: -0.12,
  label: "neutral",
  samples: 34,
  confidence: 0.71,
  evidence_ref: ["wechat:c1:1001"],
};

const alias = {
  alias_id: "40000000-0000-0000-0000-000000000004",
  person_id: "p_0001",
  platform: "wechat",
  alias_kind: "platform_uid",
  alias: "wxid_abc",
  normalized: "wxid_abc",
  is_primary: true,
  confidence: 1,
  source: "extractor",
  created_at: iso,
  updated_at: iso,
};

const relationship = {
  relation_id: "50000000-0000-0000-0000-000000000005",
  subject_id: "me",
  counterpart_id: "p_0001",
  scope_kind: "global",
  scope_id: "",
  relation_type: "friend",
  direction: "bidirectional",
  closeness: 0.7,
  sentiment: 0.2,
  tags: ["同学"],
  note: "",
  evidence_ref: ["wechat:c1:1"],
  source: "auto",
  manual_locked: false,
  produced_by: "mining:graph-v1",
  created_at: iso,
  updated_at: iso,
};

const detail = {
  person: {
    person_id: "p_0001",
    subject_kind: "contact",
    display_name: "张三",
    remark: "三哥",
    sort_key: "zs",
    avatar_ref: null,
    status: "active",
    merged_into: null,
    first_ts_ms: 1_710_000_000_000,
    last_ts_ms: null,
    msg_count: 1284,
    conv_count: 12,
    manual_locked: false,
    sentiment_trend: [sentimentPoint],
  },
  aliases: [alias],
  relationships: [relationship],
};

describe("person-detail.ts — SentimentTrendPointSchema（DESIGN-14 §4.1）", () => {
  it("接受周 / 月两种 period 格式，拒绝其他格式", () => {
    expect(SentimentTrendPointSchema.parse(sentimentPoint).label).toBe("neutral");
    expect(SentimentTrendPointSchema.parse({ ...sentimentPoint, period: "2026-09" }).period).toBe(
      "2026-09",
    );
    expect(SentimentTrendPointSchema.safeParse({ ...sentimentPoint, period: "2026W36" }).success).toBe(false);
  });

  it("score 越界 / 未知 label 被拒；evidence_ref 缺省补 []", () => {
    expect(SentimentTrendPointSchema.safeParse({ ...sentimentPoint, score: 1.2 }).success).toBe(false);
    expect(SentimentTrendPointSchema.safeParse({ ...sentimentPoint, label: "angry" }).success).toBe(false);
    const { evidence_ref: _drop, ...noEvidence } = sentimentPoint;
    expect(SentimentTrendPointSchema.parse(noEvidence).evidence_ref).toEqual([]);
  });
});

describe("person-detail.ts — PersonDetailSchema（DESIGN-19 §3.4）", () => {
  it("解析 golden JSON 并套用 warnings 默认 []", () => {
    const parsed = PersonDetailSchema.parse(detail);
    expect(parsed.person.display_name).toBe("张三");
    expect(parsed.person.first_ts_ms).toBe(1_710_000_000_000);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.aliases).toHaveLength(1);
  });

  it("strict：person 内未知 key 被拒（话题分布不进 person 对象）", () => {
    const bad = { ...detail, person: { ...detail.person, topic_dist: [] } };
    expect(PersonDetailSchema.safeParse(bad).success).toBe(false);
  });

  it("manual_locked 只接受 boolean（不接受 0/1）", () => {
    const bad = { ...detail, person: { ...detail.person, manual_locked: 1 } };
    expect(PersonDetailSchema.safeParse(bad).success).toBe(false);
  });

  it("sentiment_trend 最多 12 期（SENTIMENT_TREND_MAX_PERIODS）", () => {
    const thirteen = Array.from({ length: 13 }, () => sentimentPoint);
    const bad = { ...detail, person: { ...detail.person, sentiment_trend: thirteen } };
    expect(PersonDetailSchema.safeParse(bad).success).toBe(false);
  });
});

describe("person-detail.ts — PersonPatchSchema / RelationshipPatchSchema（§4.1 白名单）", () => {
  it("PersonPatchSchema 接受 3 个白名单字段的任意子集", () => {
    expect(PersonPatchSchema.parse({}).display_name).toBeUndefined();
    expect(PersonPatchSchema.parse({ display_name: "张三" }).remark).toBeUndefined();
    expect(PersonPatchSchema.safeParse({ display_name: "" }).success).toBe(false);
  });

  it("PersonPatchSchema strict：白名单外字段被拒", () => {
    expect(PersonPatchSchema.safeParse({ msg_count: 1 }).success).toBe(false);
  });

  it("RelationshipPatchSchema 接受 5 个白名单字段，拒绝非白名单字段", () => {
    const patch = {
      relation_type: "colleague",
      closeness: 0.8,
      sentiment: -0.1,
      tags: ["同事"],
      note: "改备注",
    };
    expect(RelationshipPatchSchema.parse(patch).relation_type).toBe("colleague");
    expect(RelationshipPatchSchema.safeParse({ evidence_ref: ["x"] }).success).toBe(false);
    expect(RelationshipPatchSchema.safeParse({ closeness: 1.5 }).success).toBe(false);
  });
});

describe("person-detail.ts — EventWriteRequestSchema（DESIGN-19 §6.3）", () => {
  it("套用 summary / event_kind / importance / tags 默认值", () => {
    const parsed = EventWriteRequestSchema.parse({
      title: "一起吃饭",
      event_date: "2026-09-05",
    });
    expect(parsed.summary).toBe("");
    expect(parsed.event_kind).toBe("other");
    expect(parsed.importance).toBe(3);
    expect(parsed.tags).toEqual([]);
  });

  it("title ≤30 / summary ≤200 / event_date 格式 / tags ≤5 越界被拒", () => {
    const base = { title: "t", event_date: "2026-09-05" };
    expect(EventWriteRequestSchema.safeParse({ ...base, title: "x".repeat(31) }).success).toBe(false);
    expect(EventWriteRequestSchema.safeParse({ ...base, summary: "x".repeat(201) }).success).toBe(false);
    expect(EventWriteRequestSchema.safeParse({ ...base, event_date: "2026/09/05" }).success).toBe(
      false,
    );
    expect(
      EventWriteRequestSchema.safeParse({ ...base, tags: ["a", "b", "c", "d", "e", "f"] }).success,
    ).toBe(false);
  });

  it("N6（修正）用 .partial() 接受部分字段", () => {
    const partial = EventWriteRequestSchema.partial();
    expect(partial.parse({ importance: 1 }).title).toBeUndefined();
    expect(partial.safeParse({ event_kind: "party" }).success).toBe(false);
  });
});

describe("person-detail.ts — TraceRowSchema（DESIGN-13 §8.2）", () => {
  const row = {
    message_id: "wechat:c1:1001",
    conversation_id: "wechat:c1",
    ts_ms: 1_710_000_000_000,
    msg_date: "2026-09-05",
    sender_name: "张三",
    content_type: "text",
    content_excerpt: "周六在望京吃饭",
  };

  it("接受 v_chat_messages 一行投影", () => {
    expect(TraceRowSchema.parse(row).content_type).toBe("text");
  });

  it("content_type 封闭枚举 + content_excerpt ≤200 字符", () => {
    expect(TraceRowSchema.safeParse({ ...row, content_type: "sticker" }).success).toBe(false);
    expect(TraceRowSchema.safeParse({ ...row, content_excerpt: "x".repeat(201) }).success).toBe(false);
  });
});

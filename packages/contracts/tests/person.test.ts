import { describe, it, expect } from "vitest";
import {
  PersonIdSchema,
  ScopeKindSchema,
  SubjectKindSchema,
  PersonStatusSchema,
  AliasPlatformSchema,
  AliasKindSchema,
  AliasSourceSchema,
  RelationTypeSchema,
  RelationshipDirectionSchema,
  RelationshipSourceSchema,
  EventScopeKindSchema,
  EventSourceKindSchema,
  PersonProfileSchema,
  AliasSchema,
  RelationshipSchema,
  EventSchema,
  MergeCandidateSchema,
} from "../src/person";

const iso = "2026-09-09T20:00:00+08:00";

const profile = {
  person_id: "me",
  subject_kind: "self",
  display_name: "我",
  remark: "",
  sort_key: "",
  avatar_ref: null,
  status: "active",
  merged_into: null,
  first_msg_at: iso,
  last_msg_at: null,
  msg_count: 0,
  conv_count: 0,
  profile_json: {},
  manual_locked: false,
  created_at: iso,
  updated_at: iso,
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

const event = {
  event_id: "60000000-0000-0000-0000-000000000006",
  subject_id: "me",
  person_id: "p_0001",
  conversation_id: "wechat:c1",
  scope_kind: "direct",
  event_kind: "meetup",
  title: "一起吃饭",
  summary: "周六在望京吃饭",
  event_date: "2026-09-05",
  occurred_at: null,
  importance: 3,
  tags: ["meetup"],
  source_kind: "message",
  source_ref: ["wechat:c1:1"],
  confidence: 0.85,
  manual_locked: false,
  produced_by: "mining:event-rule-v1",
  created_at: iso,
  updated_at: iso,
};

describe("person 行形态 schema", () => {
  it("PersonIdSchema 接受 'me' 与 UUID 形态，拒绝空串", () => {
    expect(PersonIdSchema.safeParse("me").success).toBe(true);
    expect(PersonIdSchema.safeParse("").success).toBe(false);
  });

  it("枚举原子逐字对应 DESIGN-10 CHECK 约束", () => {
    expect(ScopeKindSchema.options).toEqual(["global", "direct", "group"]);
    expect(SubjectKindSchema.options).toEqual(["self", "contact"]);
    expect(PersonStatusSchema.options).toEqual(["active", "archived", "merged"]);
    expect(AliasPlatformSchema.options).toContain("wechat");
    expect(AliasKindSchema.options).toContain("platform_uid");
    expect(AliasSourceSchema.options).toEqual(["extractor", "auto_merge", "manual"]);
    expect(RelationTypeSchema.options).toHaveLength(9);
    expect(RelationshipDirectionSchema.options).toHaveLength(3);
    expect(RelationshipSourceSchema.options).toEqual(["auto", "manual", "import"]);
    expect(EventScopeKindSchema.options).toEqual(["me", "direct", "group"]);
    expect(EventSourceKindSchema.options).toEqual(["message", "proposal", "manual"]);
    expect(PersonStatusSchema.safeParse("deleted").success).toBe(false);
  });

  it("PersonProfileSchema 接受 persons 表一行", () => {
    const parsed = PersonProfileSchema.parse(profile);
    expect(parsed.manual_locked).toBe(false);
    expect(parsed.last_msg_at).toBeNull();
  });

  it("AliasSchema 接受 aliases 表一行（无 manual_locked 列）", () => {
    expect(AliasSchema.parse(alias).is_primary).toBe(true);
    expect(AliasSchema.safeParse({ ...alias, manual_locked: false }).success).toBe(true);
  });

  it("RelationshipSchema 接受 relationships 表一行（含 produced_by 加列）", () => {
    expect(RelationshipSchema.parse(relationship).produced_by).toBe("mining:graph-v1");
    expect(RelationshipSchema.safeParse({ ...relationship, closeness: 1.2 }).success).toBe(false);
  });

  it("EventSchema 接受 events 表一行（含 event_kind / produced_by 加列）", () => {
    expect(EventSchema.parse(event).event_kind).toBe("meetup");
    expect(EventSchema.safeParse({ ...event, event_kind: "party" }).success).toBe(false);
    expect(EventSchema.safeParse({ ...event, event_date: "2026/09/05" }).success).toBe(false);
  });

  it("MergeCandidateSchema 接受候选并套用 blocked_reasons 默认", () => {
    const parsed = MergeCandidateSchema.parse({
      from_person_id: "p_0001",
      into_person_id: "p_0002",
      confidence: 0.95,
      evidence_alias_ids: ["a1", "a2"],
    });
    expect(parsed.blocked_reasons).toEqual([]);
  });
});

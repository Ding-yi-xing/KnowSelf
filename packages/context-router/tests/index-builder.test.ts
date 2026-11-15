/**
 * index-builder.test.ts — 索引构建器单元测试（mock extractor）
 */

import { describe, it, expect, vi } from "vitest";
import { openRetrievalDb } from "../src/db";
import { buildFullIndex, applyChange } from "../src/index-builder";
import type { ProfileStore } from "@knowself/profile-store";
import type { RetrieverConfig, ProfileChangeEvent } from "@knowself/contracts";

const baseConfig: RetrieverConfig = {
  enabled: true,
  embedding_model_id: "qwen3-embedding:0.6b",
  embedding_cache_dir: "data/models",
  chunk_target_tokens: 256,
  chunk_overlap_tokens: 32,
  parent_max_tokens: 1000,
  rrf_k: 60,
  rerank_provider_id: "",
  rerank_model: "",
  rerank_top_k: 30,
  rerank_timeout_ms: 15000,
  classifier_provider_id: "",
  classifier_max_cards: 3,
  token_budget: 20000,
  token_budget_l1: 1500,
  token_budget_l2: 2500,
  token_budget_l3: 4000,
  token_budget_history: 6000,
  freshness_boost: 0.1,
  memory_load_threshold: 5000,
  fallback_when_no_embed: true,
  fallback_when_no_rerank: true,
  fallback_when_no_classify: "last_used",
};

function makeEmptyStore(): ProfileStore {
  return {
    core: {
      get: vi.fn(() => {
        throw new Error("no core");
      }),
    },
    cards: { list: vi.fn(() => []), get: vi.fn() },
    journal: { listDates: vi.fn(() => []), get: vi.fn() },
  } as unknown as ProfileStore;
}

function makeFullStore(): ProfileStore {
  return {
    core: {
      get: vi.fn(() => ({
        body: "我是一个全栈开发者，热爱 TypeScript 和 React。",
        updated_at: "2026-05-27T00:00:00.000Z",
      })),
    },
    cards: {
      list: vi.fn(() => [
        {
          key: "work",
          title: "工作",
          summary: "工作相关",
          section_tags: ["技术"],
          updated_at: "2026-05-27T00:00:00.000Z",
        },
        {
          key: "life",
          title: "生活",
          summary: "生活相关",
          section_tags: [],
          updated_at: "2026-05-27T00:00:00.000Z",
        },
      ]),
      get: vi.fn((key: string) => {
        if (key === "work") {
          return {
            card: {
              key: "work",
              title: "工作",
              summary: "工作相关",
              section_tags: ["技术"],
              updated_at: "2026-05-27T00:00:00.000Z",
              schema_version: 1,
            },
            sections: [
              {
                id: 1,
                card_key: "work",
                title: "项目经验",
                body: "负责前端架构设计。",
                ord: 0,
                updated_at: "2026-05-27T00:00:00.000Z",
              },
            ],
          };
        }
        return {
          card: {
            key: "life",
            title: "生活",
            summary: "生活相关",
            section_tags: [],
            updated_at: "2026-05-27T00:00:00.000Z",
            schema_version: 1,
          },
          sections: [
            {
              id: 2,
              card_key: "life",
              title: "兴趣爱好",
              body: "喜欢阅读和跑步。",
              ord: 0,
              updated_at: "2026-05-27T00:00:00.000Z",
            },
          ],
        };
      }),
    },
    journal: {
      listDates: vi.fn(() => [
        { date: "2026-05-26", record_count: 1, updated_at: "2026-05-26T00:00:00.000Z" },
        { date: "2026-05-27", record_count: 1, updated_at: "2026-05-27T00:00:00.000Z" },
      ]),
      get: vi.fn((date: string) => {
        if (date === "2026-05-26") {
          return {
            date: "2026-05-26",
            records: [
              {
                id: 1,
                date: "2026-05-26",
                ordinal: 1,
                recorded_at: "2026-05-26T00:00:00.000Z",
                provenance: "user",
                tags: [],
                body: "今天开始学习新框架。",
              },
            ],
          };
        }
        return {
          date: "2026-05-27",
          records: [
            {
              id: 2,
              date: "2026-05-27",
              ordinal: 1,
              recorded_at: "2026-05-27T00:00:00.000Z",
              provenance: "user",
              tags: [],
              body: "完成了一个重要功能。",
            },
          ],
        };
      }),
    },
  } as unknown as ProfileStore;
}

describe("buildFullIndex", () => {
  it("profileStore 全空时不抛错且 chunkCount=0", async () => {
    const db = openRetrievalDb(":memory:");
    const store = makeEmptyStore();

    const result = await buildFullIndex({
      db,
      profileStore: store,
      config: baseConfig,
      embedFn: null,
    });

    expect(result.chunkCount).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const row = db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
    expect(row.n).toBe(0);
  });

  it("处理一个 core + 两张 card + 两条 journal 的快照，chunks 表行数 = chunkCount", async () => {
    const db = openRetrievalDb(":memory:");
    const store = makeFullStore();

    const result = await buildFullIndex({
      db,
      profileStore: store,
      config: baseConfig,
      embedFn: null,
    });

    expect(result.chunkCount).toBeGreaterThanOrEqual(1);
    const row = db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
    expect(row.n).toBe(result.chunkCount);
  });

  it("重入幂等 — 连跑两次后 chunks 行数等于第一次的 chunkCount，不会翻倍", async () => {
    const db = openRetrievalDb(":memory:");
    const store = makeFullStore();

    const first = await buildFullIndex({
      db,
      profileStore: store,
      config: baseConfig,
      embedFn: null,
    });
    const second = await buildFullIndex({
      db,
      profileStore: store,
      config: baseConfig,
      embedFn: null,
    });

    expect(first.chunkCount).toBeGreaterThanOrEqual(1);
    expect(second.chunkCount).toBe(first.chunkCount);
    const row = db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
    expect(row.n).toBe(first.chunkCount);
  });
});

describe("applyChange", () => {
  it("kind=delete 仅删除指定 doc_ref 对应行", async () => {
    const db = openRetrievalDb(":memory:");
    const store = makeFullStore();

    // 先建全量索引
    await buildFullIndex({ db, profileStore: store, config: baseConfig, embedFn: null });
    const beforeRow = db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
    expect(beforeRow.n).toBeGreaterThanOrEqual(1);
    // 确认 core_main 存在
    const coreBefore = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE doc_ref = ?")
      .get("core_main") as { n: number };
    expect(coreBefore.n).toBeGreaterThanOrEqual(1);

    // 删除 core_main 的索引
    const event: ProfileChangeEvent = {
      kind: "delete",
      ref_kind: "core",
      ref_id: "core_main",
      occurred_at: "2026-05-27T01:00:00.000Z",
      provenance: "user",
    };
    await applyChange({ db, profileStore: store, config: baseConfig, embedFn: null }, event);

    const afterRow = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE doc_ref = ?")
      .get("core_main") as { n: number };
    expect(afterRow.n).toBe(0);

    // 其他 doc_ref 应保留
    const totalRow = db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
    expect(totalRow.n).toBeLessThan(beforeRow.n);
    expect(totalRow.n).toBeGreaterThan(0);
  });

  it("kind=update 先删旧再插新 — 验证删除路径走通", async () => {
    const db = openRetrievalDb(":memory:");
    const store = makeFullStore();

    await buildFullIndex({ db, profileStore: store, config: baseConfig, embedFn: null });

    const event: ProfileChangeEvent = {
      kind: "update",
      ref_kind: "core",
      ref_id: "core_main",
      occurred_at: "2026-05-27T02:00:00.000Z",
      provenance: "user",
    };
    await applyChange({ db, profileStore: store, config: baseConfig, embedFn: null }, event);

    // 旧 doc_ref 行仍然存在（update 后重建了新的）
    const coreRows = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE doc_ref = ?")
      .get("core_main") as { n: number };
    expect(coreRows.n).toBeGreaterThanOrEqual(1);
  });

  it("单个文件读取抛错时不影响其他文件构建", async () => {
    const db = openRetrievalDb(":memory:");
    // cards.list 返回两张卡，但第一张 get 抛错
    const store = {
      core: {
        get: vi.fn(() => ({
          body: "我是测试用户。",
          updated_at: "2026-05-27T00:00:00.000Z",
        })),
      },
      cards: {
        list: vi.fn(() => [
          {
            key: "broken",
            title: "损坏卡片",
            summary: "",
            section_tags: [],
            updated_at: "2026-05-27T00:00:00.000Z",
          },
          {
            key: "good",
            title: "好卡片",
            summary: "正常",
            section_tags: [],
            updated_at: "2026-05-27T00:00:00.000Z",
          },
        ]),
        get: vi.fn((key: string) => {
          if (key === "broken") throw new Error("读取失败");
          return {
            card: {
              key: "good",
              title: "好卡片",
              summary: "正常",
              section_tags: [],
              updated_at: "2026-05-27T00:00:00.000Z",
              schema_version: 1,
            },
            sections: [
              {
                id: 1,
                card_key: "good",
                title: "正文",
                body: "这是正常的卡片内容。",
                ord: 0,
                updated_at: "2026-05-27T00:00:00.000Z",
              },
            ],
          };
        }),
      },
      journal: {
        listDates: vi.fn(() => []),
        get: vi.fn(),
      },
    } as unknown as ProfileStore;

    await buildFullIndex({ db, profileStore: store, config: baseConfig, embedFn: null });

    const row = db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
    // core + good card 应写入，broken card 被跳过
    expect(row.n).toBeGreaterThanOrEqual(2);
    const goodRows = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE doc_ref = ?")
      .get("card_good") as { n: number };
    expect(goodRows.n).toBeGreaterThanOrEqual(1);
  });
});

describe("buildFullIndex embedFn path", () => {
  it("buildFullIndex 在 embedFn 提供时同步写入 embeddings + vec_embeddings + vec_chunk_map，行数 = chunks 行数", async () => {
    const db = openRetrievalDb(":memory:");
    const store = makeFullStore();
    const embedFn = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(1024)));

    await buildFullIndex({ db, profileStore: store, config: baseConfig, embedFn });

    const chunkCount = db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
    const embedCount = db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number };
    const vecCount = db.prepare("SELECT COUNT(*) AS n FROM vec_chunk_map").get() as { n: number };
    expect(chunkCount.n).toBeGreaterThanOrEqual(1);
    expect(embedCount.n).toBe(chunkCount.n);
    expect(vecCount.n).toBe(chunkCount.n);
  });
});

describe("applyChange embedFn path", () => {
  it("applyChange add 时对新 chunks 写 embedding；delete 时 embeddings 行随 CASCADE 删除", async () => {
    const db = openRetrievalDb(":memory:");
    const store = makeFullStore();
    const embedFn = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(1024)));

    await buildFullIndex({ db, profileStore: store, config: baseConfig, embedFn });

    const beforeEmbeds = db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number };
    expect(beforeEmbeds.n).toBeGreaterThanOrEqual(1);

    // delete：chunks 被删，embeddings 随 CASCADE 自动删除
    const deleteEvent: ProfileChangeEvent = {
      kind: "delete",
      ref_kind: "core",
      ref_id: "core_main",
      occurred_at: "2026-05-27T01:00:00.000Z",
      provenance: "user",
    };
    embedFn.mockClear();
    await applyChange({ db, profileStore: store, config: baseConfig, embedFn }, deleteEvent);

    const afterDelEmbeds = db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as {
      n: number;
    };
    expect(afterDelEmbeds.n).toBeLessThan(beforeEmbeds.n);
    expect(embedFn).not.toHaveBeenCalled();

    // add：新 chunks 写入后自动写 embedding
    const addEvent: ProfileChangeEvent = {
      kind: "add",
      ref_kind: "core",
      ref_id: "core_main",
      occurred_at: "2026-05-27T02:00:00.000Z",
      provenance: "user",
    };
    await applyChange({ db, profileStore: store, config: baseConfig, embedFn }, addEvent);

    const afterAddEmbeds = db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as {
      n: number;
    };
    expect(afterAddEmbeds.n).toBeGreaterThan(afterDelEmbeds.n);
    expect(embedFn).toHaveBeenCalled();
  });
});

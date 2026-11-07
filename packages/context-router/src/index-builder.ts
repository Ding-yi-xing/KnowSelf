/**
 * index-builder.ts — 全量索引构建与增量更新
 *
 * buildFullIndex: 从 profileStore 读取全部档案数据并建索引。
 * applyChange: 根据 ProfileChangeEvent 增量更新 chunks/embeddings。
 */

import type {
  ChunkRecord,
  RetrieverConfig,
  ProfileChangeEvent,
  CardSummary,
} from "@knowself/contracts";
import type { ProfileStore } from "@knowself/profile-store";
import type { RetrievalDb } from "./db";
import type { EmbedFn } from "./embedding";
import { chunkDocument } from "./chunker";
import { countTokens } from "./token";

// ─── deps ─────────────────────────────────────────────────────────────

interface BuilderDeps {
  db: RetrievalDb;
  profileStore: ProfileStore;
  config: RetrieverConfig;
  embedFn: EmbedFn | null;
}

// ─── SQL 模板 ─────────────────────────────────────────────────────────

function insertChunk(db: RetrievalDb, c: ChunkRecord): void {
  db.prepare(
    `INSERT INTO chunks (doc_id, doc_source, doc_ref, parent_index, child_index,
       parent_text, child_text, tokens, tags, updated_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.doc_id,
    c.doc_source,
    c.doc_path,
    c.parent_index,
    c.child_index,
    c.parent_text,
    c.child_text,
    c.tokens,
    JSON.stringify(c.tags),
    c.updated_at,
    c.indexed_at,
  );
}

function deleteByDocRef(db: RetrievalDb, docRef: string): void {
  // 在 CASCADE 删除 vec_chunk_map 前先收集要清理的 vec_rowid
  const orphans = db
    .prepare(
      "SELECT vec_rowid FROM vec_chunk_map WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_ref = ?)",
    )
    .all(docRef) as { vec_rowid: number }[];

  db.transaction(() => {
    for (const o of orphans) {
      db.prepare("DELETE FROM vec_embeddings WHERE rowid = ?").run(o.vec_rowid);
    }
    db.prepare("DELETE FROM chunks WHERE doc_ref = ?").run(docRef);
  })();
}

async function writeEmbeddingsForRows(
  db: RetrievalDb,
  embedFn: EmbedFn,
  modelId: string,
  rows: { id: number; child_text: string }[],
): Promise<void> {
  const insertStmt = db.prepare(
    "INSERT INTO embeddings (chunk_id, model_id, dim, vector, indexed_at) VALUES (?, ?, ?, ?, ?)",
  );
  const vecInsertStmt = db.prepare("INSERT INTO vec_embeddings(embedding) VALUES (?)");
  const mapInsertStmt = db.prepare("INSERT INTO vec_chunk_map(vec_rowid, chunk_id) VALUES (?, ?)");
  const now = new Date().toISOString();

  for (let i = 0; i < rows.length; i += 16) {
    const batch = rows.slice(i, i + 16);
    const texts = batch.map((r) => r.child_text);
    try {
      const vectors = await embedFn(texts);
      db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const v = vectors[j]!;
          const buf = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
          insertStmt.run(batch[j]!.id, modelId, v.length, buf, now);
          const info = vecInsertStmt.run(buf);
          mapInsertStmt.run(Number(info.lastInsertRowid), batch[j]!.id);
        }
      })();
    } catch (e) {
      console.warn("Embedding batch failed, skipping", e);
    }
  }
}

// ─── 全量构建 ─────────────────────────────────────────────────────────

export async function buildFullIndex(
  deps: BuilderDeps,
): Promise<{ chunkCount: number; durationMs: number }> {
  const t0 = Date.now();

  // 清空旧索引
  deps.db.transaction(() => {
    deps.db.raw.exec("DELETE FROM chunks");
    // FTS5 由触发器自动同步；embeddings 由 CASCADE 自动删
    // vec_embeddings 是虚拟表，不支持 CASCADE，需手动清
    deps.db.raw.exec("DELETE FROM vec_embeddings");
    deps.db.raw.exec("DELETE FROM vec_chunk_map");
  })();

  let chunkCount = 0;

  deps.db.transaction(() => {
    // 1. L1 核心档案
    try {
      const core = deps.profileStore.core.get();
      const coreChunks = chunkDocument({
        doc: {
          id: "core_main",
          source: "core",
          path: "core_main",
          updatedAt: core.updated_at,
        },
        body: core.body,
        parentMaxTokens: deps.config.parent_max_tokens,
        childTargetTokens: deps.config.chunk_target_tokens,
        childOverlapTokens: deps.config.chunk_overlap_tokens,
        countTokens,
      });
      for (const c of coreChunks) {
        insertChunk(deps.db, c);
        chunkCount++;
      }
    } catch {
      // core 可能尚未初始化，跳过
    }

    // 2. L2 卡片
    const cards: CardSummary[] = deps.profileStore.cards.list();
    for (const cardSummary of cards) {
      try {
        const card = deps.profileStore.cards.get(cardSummary.key);
        const bodyParts: string[] = [];
        for (const s of card.sections) {
          bodyParts.push(`## ${s.title}\n${s.body}`);
        }
        const body = bodyParts.join("\n\n");
        if (!body.trim()) continue;

        const cardChunks = chunkDocument({
          doc: {
            id: `card_${card.card.key}`,
            source: "card",
            path: `card_${card.card.key}`,
            updatedAt: card.card.updated_at,
          },
          body,
          parentMaxTokens: deps.config.parent_max_tokens,
          childTargetTokens: deps.config.chunk_target_tokens,
          childOverlapTokens: deps.config.chunk_overlap_tokens,
          countTokens,
        });
        for (const c of cardChunks) {
          insertChunk(deps.db, c);
          chunkCount++;
        }
      } catch {
        // 卡片读取失败，跳过
      }
    }

    // 3. L3 日记
    const dates = deps.profileStore.journal.listDates();
    for (const dateSummary of dates) {
      try {
        const entry = deps.profileStore.journal.get(dateSummary.date);
        for (const record of entry.records) {
          const journalChunks = chunkDocument({
            doc: {
              id: `journal_${record.date}`,
              source: "journal",
              path: `journal_${record.date}`,
              updatedAt: record.recorded_at,
            },
            body: record.body,
            parentMaxTokens: deps.config.parent_max_tokens,
            childTargetTokens: deps.config.chunk_target_tokens,
            childOverlapTokens: deps.config.chunk_overlap_tokens,
            countTokens,
          });
          for (const c of journalChunks) {
            insertChunk(deps.db, c);
            chunkCount++;
          }
        }
      } catch {
        // 日记读取失败，跳过
      }
    }
  })();

  // Embedding 写入
  if (deps.embedFn) {
    const modelId = deps.config.embed_model_id ?? "Xenova/bge-small-zh-v1.5";
    const rows = deps.db
      .prepare(
        "SELECT id, child_text FROM chunks WHERE id NOT IN (SELECT chunk_id FROM embeddings)",
      )
      .all() as { id: number; child_text: string }[];
    if (rows.length > 0) {
      await writeEmbeddingsForRows(deps.db, deps.embedFn, modelId, rows);
    }
  }

  return { chunkCount, durationMs: Date.now() - t0 };
}

// ─── 增量更新 ─────────────────────────────────────────────────────────

export async function applyChange(deps: BuilderDeps, event: ProfileChangeEvent): Promise<void> {
  // 根据 ref_kind 确定 doc_ref
  const docRef = event.ref_id;
  const docId = docRef; // 使用 ref_id 作为 doc_id

  deps.db.transaction(() => {
    // 删除旧 chunks
    deleteByDocRef(deps.db, docRef);

    // 如果是 delete 事件，仅删除即可
    if (event.kind === "delete") return;

    // add / update：重建该文档的 chunks
    try {
      // 按 ref_kind 读取对应数据
      if (event.ref_kind === "core") {
        const core = deps.profileStore.core.get();
        const chunks = chunkDocument({
          doc: {
            id: docId,
            source: "core",
            path: docRef,
            updatedAt: core.updated_at,
          },
          body: core.body,
          parentMaxTokens: deps.config.parent_max_tokens,
          childTargetTokens: deps.config.chunk_target_tokens,
          childOverlapTokens: deps.config.chunk_overlap_tokens,
          countTokens,
        });
        for (const c of chunks) insertChunk(deps.db, c);
      } else if (event.ref_kind === "card") {
        const cardKey = docRef.replace(/^card_/, "");
        const card = deps.profileStore.cards.get(cardKey);
        const bodyParts: string[] = [];
        for (const s of card.sections) {
          bodyParts.push(`## ${s.title}\n${s.body}`);
        }
        const body = bodyParts.join("\n\n");
        if (body.trim()) {
          const chunks = chunkDocument({
            doc: {
              id: docId,
              source: "card",
              path: docRef,
              updatedAt: card.card.updated_at,
            },
            body,
            parentMaxTokens: deps.config.parent_max_tokens,
            childTargetTokens: deps.config.chunk_target_tokens,
            childOverlapTokens: deps.config.chunk_overlap_tokens,
            countTokens,
          });
          for (const c of chunks) insertChunk(deps.db, c);
        }
      } else {
        // card_section / journal_record：按具体逻辑处理
        // MVP 简化：不做 section 级增量，走全量重建
        // 实际生产环境可扩展
      }
    } catch {
      // 读取失败，跳过（可能该文档已不存在）
    }
  })();

  if (deps.embedFn && event.kind !== "delete") {
    const modelId = deps.config.embed_model_id ?? "Xenova/bge-small-zh-v1.5";
    const newRows = deps.db
      .prepare(
        "SELECT id, child_text FROM chunks WHERE doc_ref = ? AND id NOT IN (SELECT chunk_id FROM embeddings)",
      )
      .all(docRef) as { id: number; child_text: string }[];
    if (newRows.length > 0) {
      await writeEmbeddingsForRows(deps.db, deps.embedFn, modelId, newRows);
    }
  }
}

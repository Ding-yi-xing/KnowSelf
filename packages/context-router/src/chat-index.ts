/**
 * chat-index.ts — 聊天原文索引构建（retrieval.sqlite · chat_* 表）
 *
 * 依据：DESIGN-10 §7.1 / §7.2 / §7.4（K-33 / K-36 的写入侧）
 *
 * 关键口径：
 *   - **只读 person-store 的公开读接口**（结构注入，不直接打开 persons.sqlite，也不加包依赖）
 *   - 窗口切分：同一会话内相邻消息间隔 ≤ 30 分钟且窗口 ≤ 20 条（DESIGN-12 `SESSION_GAP_MS`）
 *   - FTS 走**消息级**：每行一条消息，`seg_text` 用 jieba `cutForSearch` 预分词（修复中文单字 token）
 *   - 向量走**窗口级**：向量只写在窗口代表行（窗口首条消息），`parent_text` 存整个窗口文本
 *   - 幂等：按 `conversation_id` 先删后建；`chat_vec_embeddings` 无 FK，需按映射手工清行
 */

import { cutForSearch } from "@node-rs/jieba";
import type { RetrievalDb } from "./db";
import type { EmbedFn } from "./embedding";
import { countTokens } from "./token";

/** 会话内两条消息超过该间隔即视为新窗口（与 DESIGN-12 的会话片段规则一致）。 */
export const SESSION_GAP_MS = 30 * 60 * 1000;
/** 单窗口消息上限。 */
export const MAX_WINDOW_MESSAGES = 20;

/** person-store 读侧的最小结构面（`ChatConversationRow` / `ChatMessageRow` 的结构子集）。 */
export interface ChatIndexConversation {
  conversation_id: string;
  title: string;
  kind: string;
  owner_person_id: string;
}

export interface ChatIndexMessage {
  message_id: string;
  conversation_id: string;
  sender_id: string;
  sender_name: string;
  role: string;
  ts_ms: number;
  msg_date: string;
  content: string;
  content_type: string;
}

export interface ChatIndexSource {
  /** 只返回本人参与的会话（`owner_person_id = 'me'` 由调用方或本函数过滤）。 */
  listConversations(limit: number, offset: number): ChatIndexConversation[];
  /** 按会话分页取消息，必须按 `ts_ms` 升序。 */
  listMessages(conversationId: string, limit: number, offset: number): ChatIndexMessage[];
}

export interface ChatIndexResult {
  conversationCount: number;
  windowCount: number;
  chunkCount: number;
  embeddedCount: number;
  skippedConversations: number;
}

interface WindowMessage {
  msg: ChatIndexMessage;
  /** 窗口内序号（0 = 代表行）。 */
  index: number;
}

interface ChatWindow {
  conversation_id: string;
  /** 窗口序号（会话内自增，从 0 起）。 */
  parent_index: number;
  messages: WindowMessage[];
  start_ms: number;
}

/** 把同一会话的消息按时间间隔与条数切成窗口。 */
export function splitIntoWindows(messages: readonly ChatIndexMessage[]): ChatWindow[] {
  const windows: ChatWindow[] = [];
  let current: ChatIndexMessage[] = [];
  let parentIndex = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    windows.push({
      conversation_id: current[0]!.conversation_id,
      parent_index: parentIndex++,
      messages: current.map((msg, index) => ({ msg, index })),
      start_ms: current[0]!.ts_ms,
    });
    current = [];
  };

  for (const msg of messages) {
    if (current.length > 0) {
      const prev = current[current.length - 1]!;
      const gap = msg.ts_ms - prev.ts_ms;
      if (gap > SESSION_GAP_MS || current.length >= MAX_WINDOW_MESSAGES) flush();
    }
    current.push(msg);
  }
  flush();
  return windows;
}

/** FTS 预分词列：`cutForSearch` 结果以空格连接；去掉纯空白项。 */
export function segmentText(text: string): string {
  return cutForSearch(text)
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .join(" ");
}

/** 窗口文本（注入 prompt 用）：`发送者: 内容` 逐行拼接，非文本消息给占位符。 */
export function renderWindowText(messages: readonly ChatIndexMessage[]): string {
  return messages
    .map((m) => {
      const body = m.content_type === "text" ? m.content : `[${m.content_type}]`;
      const who = m.sender_name || m.sender_id;
      return `${who}: ${body}`;
    })
    .join("\n");
}

/** 契约 `RetrievedDoc.parent_text` 上限 8000 字符（retrieval.ts），超出截断。 */
const MAX_PARENT_TEXT = 8000;

function truncateParentText(text: string): string {
  return text.length > MAX_PARENT_TEXT ? `${text.slice(0, MAX_PARENT_TEXT - 1)}…` : text;
}

function messageBody(m: ChatIndexMessage): string {
  return m.content_type === "text" ? m.content : `[${m.content_type}]`;
}

interface Deps {
  db: RetrievalDb;
  /** 为 null 时只建 FTS，不写向量（`fallback_when_no_embed` 的写入侧降级）。 */
  embedFn: EmbedFn | null;
  /** 写入 `chat_embeddings.model_id`，必须与实际嵌入模型一致。 */
  modelId: string;
  /** 每批嵌入的窗口数（Ollama 单请求体积控制）。 */
  embedBatchSize?: number;
  /** 单会话消息分页大小。 */
  pageSize?: number;
  /** 单次构建的会话上限（防止误触全量超大库）。 */
  maxConversations?: number;
  now?: () => string;
}

/** 删除某会话的全部聊天索引（含 FTS 与向量映射）。 */
export function deleteChatConversationIndex(db: RetrievalDb, conversationId: string): void {
  const ids = db
    .prepare("SELECT id FROM chat_chunks WHERE conversation_id = ?")
    .all(conversationId) as { id: number }[];

  const deleteVec = db.prepare("DELETE FROM chat_vec_embeddings WHERE rowid = ?");
  const getVecRow = db.prepare("SELECT vec_rowid FROM chat_vec_chunk_map WHERE chunk_id = ?");
  for (const { id } of ids) {
    const row = getVecRow.get(id) as { vec_rowid: number } | undefined;
    if (row) deleteVec.run(row.vec_rowid);
  }

  // chat_embeddings / chat_vec_chunk_map 有 FK ON DELETE CASCADE；
  // 显式清理以防旧库 foreign_keys 未生效。
  db.prepare(
    "DELETE FROM chat_embeddings WHERE chunk_id IN (SELECT id FROM chat_chunks WHERE conversation_id = ?)",
  ).run(conversationId);
  db.prepare(
    "DELETE FROM chat_vec_chunk_map WHERE chunk_id IN (SELECT id FROM chat_chunks WHERE conversation_id = ?)",
  ).run(conversationId);
  // chat_chunks 的 AFTER DELETE 触发器同步删 FTS 行
  db.prepare("DELETE FROM chat_chunks WHERE conversation_id = ?").run(conversationId);
}

/**
 * 构建（或重建）聊天索引。
 *
 * 幂等：每个会话先删后建。`conversationLimit` 便于测试与增量场景。
 */
export async function buildChatIndex(
  deps: Deps,
  source: ChatIndexSource,
  opts: { conversationIds?: readonly string[] } = {},
): Promise<ChatIndexResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const pageSize = deps.pageSize ?? 500;
  const embedBatchSize = deps.embedBatchSize ?? 16;
  const maxConversations = deps.maxConversations ?? 500;

  const wanted = opts.conversationIds ? new Set(opts.conversationIds) : null;
  const all = source.listConversations(maxConversations, 0).filter(
    (c) => c.owner_person_id === "me" || c.owner_person_id === "",
  );
  const conversations = wanted ? all.filter((c) => wanted.has(c.conversation_id)) : all;

  const result: ChatIndexResult = {
    conversationCount: 0,
    windowCount: 0,
    chunkCount: 0,
    embeddedCount: 0,
    skippedConversations: 0,
  };

  const insertChunk = deps.db.prepare(
    `INSERT INTO chat_chunks
      (doc_ref, conversation_id, person_id, parent_index, child_index,
       parent_text, child_text, seg_text, ts_ms, msg_date, message_ids, tokens, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEmbedding = deps.db.prepare(
    `INSERT OR REPLACE INTO chat_embeddings (chunk_id, model_id, dim, vector, indexed_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertVec = deps.db.prepare("INSERT INTO chat_vec_embeddings (embedding) VALUES (?)");
  const insertVecMap = deps.db.prepare(
    "INSERT INTO chat_vec_chunk_map (vec_rowid, chunk_id) VALUES (?, ?)",
  );

  for (const conv of conversations) {
    const messages: ChatIndexMessage[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = source.listMessages(conv.conversation_id, pageSize, offset);
      messages.push(...page);
      if (page.length < pageSize) break;
    }
    if (messages.length === 0) {
      result.skippedConversations += 1;
      continue;
    }

    const windows = splitIntoWindows(messages);
    const tx = deps.db.transaction(() => {
      deleteChatConversationIndex(deps.db, conv.conversation_id);

      const pendingEmbed: { chunkId: number; text: string }[] = [];
      let chunkCount = 0;

      for (const win of windows) {
        const windowText = truncateParentText(
          renderWindowText(win.messages.map((w) => w.msg)),
        );
        const first = win.messages[0]!.msg;
        const docRef = `chat:${conv.conversation_id}:${first.message_id}`;
        const tokens = countTokens(windowText);

        for (const { msg, index } of win.messages) {
          const body = messageBody(msg);
          const info = insertChunk.run(
            docRef,
            conv.conversation_id,
            msg.sender_id,
            win.parent_index,
            index,
            windowText,
            body,
            segmentText(body),
            msg.ts_ms,
            msg.msg_date,
            JSON.stringify(win.messages.map((w) => w.msg.message_id)),
            tokens,
            now(),
          );
          chunkCount += 1;
          if (index === 0 && deps.embedFn) {
            pendingEmbed.push({
              chunkId: Number(info.lastInsertRowid),
              text: windowText,
            });
          }
        }
      }

      // 向量在事务提交后再写（见下方 await 段）：先落行拿到 chunk_id，避免长事务句柄住嵌入调用。

      result.chunkCount += chunkCount;
      result.windowCount += windows.length;
      result.conversationCount += 1;
      return pendingEmbed;
    });

    const pending = tx();

    if (deps.embedFn && pending.length > 0) {
      for (let i = 0; i < pending.length; i += embedBatchSize) {
        const batch = pending.slice(i, i + embedBatchSize);
        let vectors: Float32Array[] = [];
        try {
          vectors = await deps.embedFn(batch.map((b) => b.text));
        } catch {
          // 嵌入失败：保留 FTS，向量留空（下次重建补齐）
          continue;
        }
        const writeTx = deps.db.transaction(() => {
          for (let j = 0; j < batch.length; j++) {
            const vec = vectors[j];
            const item = batch[j]!;
            if (!vec) continue;
            const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
            insertEmbedding.run(item.chunkId, deps.modelId, vec.length, buf, now());
            const info = insertVec.run(JSON.stringify(Array.from(vec)));
            insertVecMap.run(Number(info.lastInsertRowid), item.chunkId);
            result.embeddedCount += 1;
          }
        });
        writeTx();
      }
    }
  }

  return result;
}

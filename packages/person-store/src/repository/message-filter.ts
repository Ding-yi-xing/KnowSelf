/**
 * 消息查询的公共过滤构造器（DESIGN-13 §2.2 行预算拆分：`messages.ts` / `message-stream.ts` 共用）。
 * 语义：`person_id` 过滤必须走 `v_chat_messages.sender_person_id`（`chat_messages.sender_id` 是平台 ID）。
 */
import type { ContentType } from "../types-chat";

export interface MessageFilter {
  join: string;
  where: string;
  params: (string | number)[];
}

export interface MessageFilterQuery {
  conversation_id?: string;
  person_id?: string;
  /** 只查直聊（direct）或群聊（group）的消息。 */
  conversation_kind?: "direct" | "group";
  from_ms?: number;
  to_ms?: number;
  content_types?: readonly ContentType[];
}

/** `stream` 的分页大小（keyset 分页，避免一次载入 10 万条）。 */
export const STREAM_PAGE = 1000;

/** LIKE 通配符转义（`%` / `_` / `\`），配合 `ESCAPE '\'` 使用（DESIGN-13 §11.1）。 */
export function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function marks(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * 批 2b 回滚四步 ④：**fail-open** 的已撤销批次排除谓词（评审定稿，构造级保证）。
 *
 * 为什么用 `NOT EXISTS` 而不是无条件 `JOIN v_chat_messages`：
 *   ① aliases 解析开销；② 视图的 `INNER JOIN chat_conversations` 会静默丢消息；
 *   ③ `CREATE VIEW IF NOT EXISTS` 不会更新既有视图。
 *
 * 两条不变量（本改动最坏的失败模式只是「撤销仍不生效」，绝不可能是「读数变少/数据消失」）：
 *   - 零回滚批次时 `NOT EXISTS` 恒 TRUE ⇒ 对存量读数是 no-op（验收 6「逐位一致」构造级成立）；
 *   - 消息的 `ingest_batches` 行缺失时同样恒 TRUE ⇒ 不会因 join 不到而丢消息。
 *
 * 谓词不含占位符 ⇒ 加入 `conditions` 后 `params` 的元素与顺序完全不变。
 *
 * UI 徽标可消费判据（本批不做前端，仅留注释）：本谓词命中（即被过滤掉）的行所属
 * batch_id 对应「此前撤销 · 需重新确认」；配合 store.isReviewRequired() 可零新增查询渲染。
 */
export const REVERTED_BATCH_GUARD =
  "NOT EXISTS (SELECT 1 FROM ingest_batches b WHERE b.batch_id = m.batch_id AND b.reverted_at IS NOT NULL)";

export function buildFilter(q: MessageFilterQuery): MessageFilter {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  const joins: string[] = [];
  if (q.person_id !== undefined) {
    joins.push("JOIN v_chat_messages v ON v.message_id = m.message_id");
    conditions.push("v.sender_person_id = ?");
    params.push(q.person_id);
  }
  if (q.conversation_kind !== undefined) {
    joins.push("JOIN chat_conversations ck ON ck.conversation_id = m.conversation_id");
    conditions.push("ck.kind = ?");
    params.push(q.conversation_kind);
  }
  if (q.conversation_id !== undefined) {
    conditions.push("m.conversation_id = ?");
    params.push(q.conversation_id);
  }
  if (q.from_ms !== undefined) {
    conditions.push("m.ts_ms >= ?");
    params.push(q.from_ms);
  }
  if (q.to_ms !== undefined) {
    conditions.push("m.ts_ms < ?");
    params.push(q.to_ms);
  }
  if (q.content_types !== undefined && q.content_types.length > 0) {
    conditions.push(`m.content_type IN (${marks(q.content_types.length)})`);
    params.push(...q.content_types);
  }
  // 无条件分支：person_id 传不传都生效。messages.count / list / searchContent /
  // histogramByDate 与 context-router 的 adaptChatStore.listMessages 共用本构造器；
  // 放最后，保证既有条件与参数顺序逐字不变。
  conditions.push(REVERTED_BATCH_GUARD);
  return { join: joins.join(" "), where: `WHERE ${conditions.join(" AND ")}`, params };
}

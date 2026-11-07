/**
 * 增量采集（DESIGN-11 §5）：游标语义 + 过滤规则 + 薄 store。
 *
 * 语义（§5.1）：
 *   - `last_ts_ms`      = 该会话**已成功落档**消息的最大 `ts_ms`；
 *   - `last_message_id` = 在 `last_ts_ms` 这一毫秒上**已落档**的最大 `message_id`。
 *
 * 纪律：
 *   1. `keep()` 严格按 `(ts_ms, message_id)` **字典序**判定，不依赖文件行序（§5.2）；
 *   2. 推进是**单调不回退**的（§5.3 L3）：`MAX(existing, incoming)`，同毫秒取 `max(message_id)`；
 *   3. 本模块**不**在落档事务里写游标——`CursorStore.advance()` 只由调用方在
 *      `commitStaged` 事务提交后调用（真正的原子推进在 person-store 落档事务内完成）；
 *   4. 与 `person-store` 无依赖：通过结构化的 `CursorRepoLike` 注入。
 */

/** 游标快照（`ingest_cursors` 的读侧子集，结构不变）。 */
export interface CursorState {
  last_ts_ms: number;
  last_message_id: string | null;
}

/** 过滤所需的最小消息形状（`NormalizedMessage` / `StagingRow` 均满足）。 */
export interface CursorMessageKey {
  ts_ms: number;
  message_id: string;
}

/** 游标读写的结构化依赖（`PersonStore['staging']` 满足，不 import person-store）。 */
export interface CursorRepoLike {
  readCursor(platform: string, conversationId: string): CursorState | null;
  advanceCursor(q: {
    platform: string;
    conversation_id: string;
    last_ts_ms: number;
    last_message_id: string;
    now: string;
  }): void;
}

/**
 * §5.2 的过滤规则：
 *
 * ```
 * keep(m) = 无游标行
 *        OR m.ts_ms >  cursor.last_ts_ms
 *        OR (m.ts_ms == cursor.last_ts_ms AND m.message_id > cursor.last_message_id)
 * ```
 *
 * `last_message_id === null` 时，同毫秒的全部消息都保留（宁可重复进 staging，
 * 由 `INSERT OR IGNORE` 去重，也不丢消息）。
 */
export function keep(message: CursorMessageKey, cursor: CursorState | null): boolean {
  if (cursor === null) return true;
  if (message.ts_ms > cursor.last_ts_ms) return true;
  if (message.ts_ms < cursor.last_ts_ms) return false;
  if (cursor.last_message_id === null) return true;
  return message.message_id > cursor.last_message_id;
}

/** 保留本批需要落档的消息（保持入参顺序）。 */
export function filterNew<T extends CursorMessageKey>(
  messages: readonly T[],
  cursor: CursorState | null,
): T[] {
  return messages.filter((message) => keep(message, cursor));
}

/** 本批 `(ts_ms, message_id)` 的最大者；空数组返回 `null`。 */
export function maxCursorOf(messages: readonly CursorMessageKey[]): CursorState | null {
  const first = messages[0];
  if (first === undefined) return null;
  let last_ts_ms = first.ts_ms;
  let last_message_id = first.message_id;
  for (const message of messages) {
    if (
      message.ts_ms > last_ts_ms ||
      (message.ts_ms === last_ts_ms && message.message_id > last_message_id)
    ) {
      last_ts_ms = message.ts_ms;
      last_message_id = message.message_id;
    }
  }
  return { last_ts_ms, last_message_id };
}

/**
 * 纯函数推进（§5.3 L3）：`last_ts_ms = MAX(existing, incoming)`；
 * 因 `MAX` 选中的是**较大的时间**，对应 `message_id` 取该批次的最大值；
 * 时间更小的一批**不得**覆盖既有游标（静默不生效，不抛错）。
 */
export function advanceCursorState(
  current: CursorState | null,
  incoming: readonly CursorMessageKey[],
): CursorState | null {
  const next = maxCursorOf(incoming);
  if (next === null) return current;
  if (current === null) return next;
  if (next.last_ts_ms > current.last_ts_ms) return next;
  if (next.last_ts_ms < current.last_ts_ms) return current;
  if (current.last_message_id === null) return next;
  if (next.last_message_id === null) return next;
  return next.last_message_id > current.last_message_id ? next : current;
}

/** 过滤器的有状态薄封装（每次会话创建一个，游标不可变）。 */
export class IncrementalFilter {
  private readonly cursor: CursorState | null;

  constructor(cursor: CursorState | null) {
    this.cursor = cursor;
  }

  /** §5.2 单条判定。 */
  keep(message: CursorMessageKey): boolean {
    return keep(message, this.cursor);
  }

  /** 批量判定（保持入参顺序）。 */
  filter<T extends CursorMessageKey>(messages: readonly T[]): T[] {
    return filterNew(messages, this.cursor);
  }

  /** 当前游标快照（只读）。 */
  snapshot(): CursorState | null {
    return this.cursor;
  }
}

/**
 * `ingest_cursors` 的薄 store。
 *
 * 推进时机（§5.3 L3）：**只在落档事务提交后**由调用方调用 `advance`。
 * 禁止在 staging 阶段推进——部分失败会跳过数据。
 */
export class CursorStore {
  private readonly repo: CursorRepoLike;

  constructor(repo: CursorRepoLike) {
    this.repo = repo;
  }

  /** 读游标；无行返回 `null`（= 首采全收）。 */
  read(platform: string, conversationId: string): CursorState | null {
    return this.repo.readCursor(platform, conversationId);
  }

  /** 读后建过滤器（等价 `new IncrementalFilter(this.read(...))`）。 */
  filterFor(platform: string, conversationId: string): IncrementalFilter {
    return new IncrementalFilter(this.read(platform, conversationId));
  }

  /**
   * 推进游标（幂等、单调不回退）。
   *
   * 返回推演后的快照（`null` = 无消息、未推进）便于调用方断言；
   * 真实写入由 person-store 的 `advanceCursor` SQL 用 `MAX` 语义兜底。
   */
  advance(
    platform: string,
    conversationId: string,
    messages: readonly CursorMessageKey[],
    now: string,
  ): CursorState | null {
    const next = advanceCursorState(this.read(platform, conversationId), messages);
    if (next === null) return null;
    this.repo.advanceCursor({
      platform,
      conversation_id: conversationId,
      last_ts_ms: next.last_ts_ms,
      last_message_id: next.last_message_id ?? "",
      now,
    });
    return next;
  }
}

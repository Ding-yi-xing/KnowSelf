/**
 * `PersonsChangeEvent` 总线（DESIGN-13 §2.2 / §4.3 步骤 ⑧ / §4.4 步骤 5）。
 * 语义：**事务提交后**发（不在事务内发）；`onCommitted` 返回取消订阅函数（DESIGN-11 §7.5 能力 9）。
 * 可重放：总线保留最近 `historyLimit` 条，`recent()` 供迟到的订阅方补课（订阅本身不自动重放，
 * 避免订阅方重复处理）。
 * 纪律：监听器抛错**不影响已提交数据**（事件可重放，由订阅方自行处理）。
 */
export type PersonsChangeKind = "messages_committed" | "batch_reverted" | "person_merged";

export interface PersonsChangeEvent {
  kind: PersonsChangeKind;
  /** ISO8601 带时区。 */
  occurred_at: string;
  batch_id?: string;
  conversation_ids?: readonly string[];
  person_ids?: readonly string[];
  committed?: number;
  skipped?: number;
  reverted?: number;
}

export type PersonsChangeListener = (event: PersonsChangeEvent) => void;

export interface PersonsEventBus {
  emit(event: PersonsChangeEvent): void;
  onCommitted(listener: PersonsChangeListener): () => void;
  /** 最近事件（按发出顺序，旧 → 新），最多 `limit` 条。 */
  recent(limit?: number): PersonsChangeEvent[];
}

const DEFAULT_HISTORY_LIMIT = 100;

export function createPersonsEventBus(
  historyLimit: number = DEFAULT_HISTORY_LIMIT,
): PersonsEventBus {
  const listeners = new Set<PersonsChangeListener>();
  const history: PersonsChangeEvent[] = [];

  const emit = (event: PersonsChangeEvent): void => {
    history.push(event);
    if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        /* 监听器异常不影响已提交数据（事件可重放） */
      }
    }
  };

  const onCommitted = (listener: PersonsChangeListener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const recent = (limit: number = historyLimit): PersonsChangeEvent[] =>
    limit >= history.length ? [...history] : history.slice(history.length - limit);

  return { emit, onCommitted, recent };
}

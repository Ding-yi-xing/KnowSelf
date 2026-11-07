/**
 * chat-index-sync.ts — 落档事件 → 聊天索引增量重建
 *
 * 背景：V2 从未调用过 `buildFullIndex`，导致 L3 检索长期恒为空；2026-11-06 已补「启动预热」
 * （init.ts 第 9 步）。本文件补另一半——**摄入完成后立即增量更新**，避免「新数据要重启才进索引」。
 *
 * 设计要点：
 *   1. 只订阅 `messages_committed`（`batch_reverted` / `person_merged` 不改变消息正文；
 *      回滚场景由下一次全量重建兜底，不在热路径上做删除）。
 *   2. **串行 + 合并**：落档可能连续触发多次，用 pending 集合去重，同一时刻只跑一个 rebuild，
 *      跑的过程中新到的会话会并入下一轮，避免并发写 retrieval.sqlite。
 *   3. 失败不冒泡：索引是派生缓存，失败只告警，不阻断落档事务（监听器抛错也不影响已提交数据）。
 *   4. `stop()` 后不再重建，供 shutdown 时清理订阅。
 */

/** 与 `PersonsChangeEvent` 结构对齐的最小子集（避免为测试引入包依赖）。 */
export interface ChatIndexChangeEvent {
  kind: string;
  conversation_ids?: readonly string[];
}

export interface ChatIndexSyncDeps {
  /** 订阅落档事件，返回取消订阅函数。 */
  onCommitted(listener: (event: ChatIndexChangeEvent) => void): () => void;
  /** 按会话重建索引。 */
  rebuild(conversationIds: readonly string[]): Promise<unknown>;
  /** 重建失败回调（缺省 console.warn）。 */
  onError?: (error: unknown, conversationIds: readonly string[]) => void;
}

export interface ChatIndexSyncHandle {
  /** 取消订阅并停止后续重建。 */
  stop(): void;
  /** 当前是否有重建在跑（测试/观测用）。 */
  isRunning(): boolean;
  /** 等待当前队列清空（测试用；生产不调用）。 */
  idle(): Promise<void>;
}

export function startChatIndexSync(deps: ChatIndexSyncDeps): ChatIndexSyncHandle {
  const onError =
    deps.onError ??
    ((error: unknown, ids: readonly string[]) => {
      console.warn(`[index] 聊天增量索引失败（${ids.length} 个会话）：`, String(error));
    });

  let pending = new Set<string>();
  let running = false;
  let stopped = false;
  let waiters: (() => void)[] = [];

  const settleWaiters = (): void => {
    const list = waiters;
    waiters = [];
    for (const resolve of list) resolve();
  };

  const flush = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      while (pending.size > 0 && !stopped) {
        const ids = [...pending];
        pending = new Set();
        try {
          await deps.rebuild(ids);
        } catch (error) {
          onError(error, ids);
        }
      }
    } finally {
      running = false;
      settleWaiters();
    }
  };

  const unsubscribe = deps.onCommitted((event) => {
    if (stopped) return;
    if (event.kind !== "messages_committed") return;
    const ids = event.conversation_ids ?? [];
    if (ids.length === 0) return;
    for (const id of ids) pending.add(id);
    void flush();
  });

  return {
    stop(): void {
      stopped = true;
      pending.clear();
      unsubscribe();
      settleWaiters();
    },
    isRunning(): boolean {
      return running;
    },
    async idle(): Promise<void> {
      if (!running && pending.size === 0) return;
      await new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}

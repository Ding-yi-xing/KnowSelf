/**
 * 人物归并（W-3 恢复 CRUD 的 `POST /person/:id/merge` 落地）。
 *
 * ## 为什么单独成模块
 * 归并不是"改一行字段"，而是**三件事必须原子完成**，否则会留下"消息指向一个被判死的 person"：
 *   1. 把源 person 的别名迁到目标 person（`aliases.moveToPerson`）；
 *   2. 标记源 person 为 `merged`（`persons.markMerged`）；
 *   3. 写一条归并审计（`persons.insertMerge`，可撤销）。
 *
 * ## 为什么没有「迁移 chat_messages.sender_person_id」这一步
 * 因为那个列**不是存储列**：`chat_messages` 只有 `sender_id`，
 * `sender_person_id` 是视图 `v_chat_messages` 里 `JOIN aliases` 现算出来的（见 `ddl/raw.ts:81-90`）。
 * 所以把别名挪到目标 person 之后，**全部历史消息自动改指向目标**，无需（也不可能）逐行 UPDATE——
 * `chat_messages` 有 append-only 触发器，UPDATE 会被 ABORT（`ddl/raw.ts:55-59`）。
 * 这比"迁移引用"更强：不会漏行、不会写脏、不需要回滚补偿。
 */
import type { PersonRow } from "./types";
import type { PersonStore } from "./store";

/** `mergePersons` 入参。 */
export interface MergePersonsInput {
  /** 被合并掉的源 person（会被标记 `merged`）。 */
  from_person_id: string;
  /** 保留的目标 person。 */
  to_person_id: string;
  /** ISO8601；缺省取当前时间。 */
  now?: string;
  /** 归并理由（进审计，缺省空串）。 */
  reason?: string;
}

/** `mergePersons` 结果（都是写后状态，便于路由直接回给前端）。 */
export interface MergePersonsResult {
  /** 合并后的源行（`status='merged'`、`merged_into=to`）。 */
  from: PersonRow;
  /** 目标行（未被改动，但回传便于前端刷新显示）。 */
  to: PersonRow;
  /** 实际迁移的别名数。 */
  moved_aliases: number;
  /** 因目标已持有同一 `(platform, alias)` 而跳过的重复别名数。 */
  dropped_duplicate_aliases: number;
}

/** 归并输入非法（自合并 / 目标不存在 / 源已是 merged）——由路由转 400。 */
export class MergeRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeRejectedError";
  }
}

/**
 * 把 `from_person_id` 并入 `to_person_id`（单事务）。
 *
 * @param store 人物库
 * @param input 见 {@link MergePersonsInput}
 * @returns 见 {@link MergePersonsResult}
 * @throws MergeRejectedError 自合并 / 源或目标不存在 / 源已是 merged / 目标是已合并的
 * @throws AliasConflictError 迁移撞唯一键（理论上前置过滤已避免，保留兜底）
 */
export function mergePersons(store: PersonStore, input: MergePersonsInput): MergePersonsResult {
  const fromId = input.from_person_id;
  const toId = input.to_person_id;
  if (fromId === toId) throw new MergeRejectedError("不能把人物合并到它自己");
  if (fromId === "me") throw new MergeRejectedError("不能合并「我」；请改用删除/归档");

  const now = input.now ?? new Date().toISOString();

  return store.transaction((): MergePersonsResult => {
    const from = store.persons.getOrThrow(fromId);
    const to = store.persons.getOrThrow(toId);
    if (from.status === "merged") {
      throw new MergeRejectedError(`人物 ${fromId} 已被合并，不能重复合并`);
    }
    if (to.status === "merged") {
      throw new MergeRejectedError(`目标人物 ${toId} 本身已被合并，请选一个未合并的目标`);
    }

    // ① 别名迁移：跳过目标已持有的同一 (platform, alias)。
    //    为什么必须过滤：`uq_aliases_platform_uid` 是 UNIQUE(platform, alias)，
    //    直接 move 会撞唯一键整笔失败——而"两个人都挂着同一个 uid 别名"在
    //    历史数据里很常见（正是要合并的原因）。
    const targetAliases = new Set(
      store.aliases.listByPerson(toId).map((alias) => `${alias.platform}\u0000${alias.alias}`),
    );
    const movable: string[] = [];
    let dropped = 0;
    for (const alias of store.aliases.listByPerson(fromId)) {
      const key = `${alias.platform}\u0000${alias.alias}`;
      if (targetAliases.has(key)) {
        dropped += 1;
        continue;
      }
      movable.push(alias.alias_id);
    }
    const moved = store.aliases.moveToPerson(movable, toId, now).moved;

    // ② 标记源为 merged（视图会立刻把历史消息解析到目标）
    store.persons.markMerged(fromId, toId, now);

    // ③ 审计（可撤销；`performed_by='manual'` 表示人来点的）
    store.persons.insertMerge({
      merge_id: `merge:${fromId}->${toId}:${now}`,
      from_person_id: fromId,
      into_person_id: toId,
      performed_by: "manual",
      merged_at: now,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      evidence: JSON.stringify({ moved_aliases: moved, dropped_duplicate_aliases: dropped }),
      confidence: 1,
    });

    return {
      from: store.persons.getOrThrow(fromId),
      to: store.persons.getOrThrow(toId),
      moved_aliases: moved,
      dropped_duplicate_aliases: dropped,
    };
  });
}

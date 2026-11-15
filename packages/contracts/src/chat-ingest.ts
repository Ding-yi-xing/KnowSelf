/**
 * chat-ingest.ts — 聊天消息落档提交器契约（DESIGN-11 §7.3）
 *
 * 定位：**纯 TS 接口，非 Zod**（DESIGN-17 §2.1 C-1 明示）。
 *
 * 为什么放 contracts：若让 `ingestion` 直接调 `person-store`，会新增一条
 * 依赖矩阵外的边。接口放 contracts，由 chat-ingest 实现并由当前宿主装配。
 *
 * 工作单元：chat-ingest（实现） / ingestion（消费） / chat-engine（装配）
 *
 * 弱模型实施提示：
 *   1. `commit` 必须幂等：重复调用返回 `skipped > 0`，**不抛错**。
 *   2. 实现方只写 persons.sqlite；**不**调 `buildLink` / `links.insert` /
 *      `proposalToWriteRequest`（profile 写入链路与本接口无关，DESIGN-11 §7.4）。
 *   3. 审计信息塞进 proposal 既有字段（`reasoning` / `produced_by_provider`），
 *      不给 `IngestionProposal` 加字段。
 */

/** 落档目标 — 载荷在 `chat_message_staging`，本 target 只存引用与分层信息。 */
export interface ChatMessageCommitTarget {
  kind: "chat_message";
  /** 批次 ID（UUID v4）。 */
  batch_id: string;
  conversation_id: string;
  /**
   * 会话显示名（W-31 加法式字段）。
   *
   * 为什么必须随 target 走：标题只在**解析导出文件时**可得（导出头部 `# 显示名`），
   * 而落档发生在之后的 accept 请求里，那时已无从回到文件。原实现不携带标题，
   * person-store 的 `resolveConversation` 只能回落到 `conversation_id`（群号），
   * 于是 `chat_conversations.title` 被写成 `1248517133@chatroom`，
   * mining 的群节点 label 直接取该字段 ⇒ 图谱里群节点显示群号而非群名。
   *
   * 缺省（老 proposal / 非 txt 来源）= 保持既有回落行为，不改变旧数据语义。
   */
  conversation_title?: string;
  /** 本 proposal 覆盖的消息（≤2000 条，按 ts_ms 升序）。 */
  message_ids: readonly string[];
  /** 置信分层（供 UI 筛选与审计）。 */
  tier: "auto" | "review";
  /** Tier B 命中的规则码；Tier A 为空数组。 */
  reason_codes: readonly string[];
}

/** `commit` 入参（DESIGN-11 §7.3 逐字抄录，仅拆出命名类型）。 */
export interface ChatMessageCommitInput {
  proposal_id: string;
  source_id: string;
  target: ChatMessageCommitTarget;
  /** ISO8601 带时区。 */
  now: string;
}

/**
 * 提交器接口 — 由 `packages/chat-ingest` 实现，经 `IngestionDeps.chatCommitter?`
 * 注入（加法式可选字段，DESIGN-11 §7.2 #5）。
 */
export interface ChatMessageCommitter {
  /** 落档一个 chat_message proposal。必须幂等：重复调用返回 skipped>0，不抛错。 */
  commit(input: ChatMessageCommitInput): { committed: number; skipped: number };
}

/** `reject` 入参（批 1.5：与 `ChatMessageCommitter` 对称）。 */
export interface ChatMessageRejectInput {
  proposal_id: string;
  target: ChatMessageCommitTarget;
  /** ISO8601 带时区。 */
  now: string;
}

/**
 * 拒绝器接口 — 由 `packages/chat-ingest` 实现，经 `IngestionDeps.chatRejecter?` 注入。
 *
 * 为什么需要它：`rejectProposal` 原先只改 `ingestion_proposals` 状态、**零触碰 staging**，
 * 而 `commitStaged` 取整会话 `status='staged'` 行 ⇒ 被拒内容照样落档。
 * 与 `ChatMessageCommitter` 对称注入，避免新增依赖矩阵外的边。
 *
 * 契约（内容级不变量，不是行数核销）：调用成功后，
 * `target.message_ids` 覆盖的消息在**全部批次**中不得再存在 `status='staged'` 行；
 * 不满足必须抛错，**不得静默返回成功**。
 */
export interface ChatMessageRejecter {
  reject(input: ChatMessageRejectInput): { rejected: number };
}

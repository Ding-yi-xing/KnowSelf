/**
 * `createPersonStore`：persons.sqlite 门面（DESIGN-13 §2.1 / §9.2 / §4.1）。
 * 本工单组装 `persons` / `aliases` / `conversations` / `messages` / `staging` 5 个仓库
 * （其余 3 个按 DESIGN-13 §12 后续工单补）；门面已透出的能力**只做加法**，不改签名。
 * DESIGN-11 §7.5 的 9 个能力：4 个在此（`ensurePersonForUid` / `commitStaged` / `revertBatch` /
 * `onCommitted`），5 个在 `staging` 仓库（`beginBatch` / `finishBatch` / `stageMessages` /
 * `rejectStaged` / `readCursor`）——能力集零缩减（DESIGN-13 §4.1）。
 */
import { commitStaged, type CommitStagedInput, type CommitStagedResult } from "./commit";
import { getPersonMeta, openPersonDb, type PersonDbOptions } from "./db";
import type { DerivedCipherDb } from "./crypto/cipher";
import {
  createPersonsEventBus,
  type PersonsChangeEvent,
  type PersonsChangeListener,
} from "./events";
import {
  ensurePersonForUid as ensurePerson,
  type EnsurePersonForUidInput,
  type EnsurePersonForUidResult,
  type IdentityDeps,
} from "./identity";
import { createAliasesRepo, type AliasesRepo } from "./repository/aliases";
import { createConversationsRepo, type ConversationsRepo } from "./repository/conversations";
import { createEventsRepo, type EventsRepo } from "./repository/events";
import { createMessagesRepo, type MessagesRepo } from "./repository/messages";
import { createMetricsRepo, type MetricsRepo } from "./repository/metrics";
import { createPersonsRepo, type PersonsRepo } from "./repository/persons";
import { createRelationshipsRepo, type RelationshipsRepo } from "./repository/relationships";
import { createReplyHistoryRepo, type ReplyHistoryRepo } from "./repository/reply-history";
import {
  createReviewRequiredRepo,
  type ReviewRequiredConversation,
  type ReviewRequiredRepo,
} from "./repository/review-required";
import { createStagingRepo, type StagingRepo } from "./repository/staging";
import { revertBatch, type RevertBatchInput, type RevertBatchResult } from "./revert";
import type { PersonListQuery, PersonRow } from "./types";

export type PersonStoreOptions = PersonDbOptions;

export interface PersonStore {
  /** 8 个仓库（DESIGN-13 §3.1 ~ §3.8）。 */
  persons: PersonsRepo;
  aliases: AliasesRepo;
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  /** DESIGN-11 §7.5 能力 1 / 2 / 3 / 6 / 7（批次 / staging / 游标）。 */
  staging: StagingRepo;
  /** DESIGN-12 §9.2 派生层三仓库（`PersonStoreMiningApi` 的能力 4 / 6 / 8~13）。 */
  relationships: RelationshipsRepo;
  events: EventsRepo;
  metrics: MetricsRepo;
  /** 仅供自动回复上下文使用的受限直聊读取面。 */
  replyHistory: ReplyHistoryRepo;
  /** DESIGN-11 §7.5 能力 4 / DESIGN-13 §4.1；幂等，`created=false` 表示复用既有。 */
  ensurePersonForUid(input: EnsurePersonForUidInput): EnsurePersonForUidResult;
  /** DESIGN-11 §7.5 能力 5：单事务落档（§4.3 步骤 ①~⑦）；幂等。 */
  commitStaged(input: CommitStagedInput): CommitStagedResult;
  /** DESIGN-11 §7.5 能力 8：批次逻辑回滚（§4.4）；幂等。 */
  revertBatch(input: RevertBatchInput): RevertBatchResult;
  /** DESIGN-11 §7.5 能力 9：订阅落档事件，返回取消订阅函数。 */
  onCommitted(listener: PersonsChangeListener): () => void;
  /** 总线保留的最近事件（可重放，DESIGN-13 §2.2）。 */
  recentChanges(limit?: number): PersonsChangeEvent[];
  /** 只读查询（FR-8.1）；不存在返回 `null`。 */
  getPerson(personId: string): PersonRow | null;
  /** DESIGN-12 §9.2 能力 2 的读侧入口（`persons.list` 的门面化）。 */
  listPersons(q?: PersonListQuery): PersonRow[];
  /** DESIGN-13 §4.2 能力 7：读 `persons_meta`（含 `timezone` / `schema_version`）。 */
  getMeta(key: string): string | undefined;
  /**
   * 批 2b 加法式：「因撤销而待复核」的会话集合（粘性解除探针，见 review-required.ts）。
   * 由 CLI 合并进 `tierConfig.review` ⇒ `MANUAL_FLAG` ⇒ Tier B，判定链路不改。
   */
  listReviewRequiredConversations(): ReviewRequiredConversation[];
  /** 单会话判据（供 UI 徽标「此前撤销 · 需重新确认」消费，零新增查询）。 */
  isReviewRequired(conversationId: string): boolean;
  transaction<T>(fn: () => T): T;
  /** 受控打开加密回复派生库，不暴露 persons 根密钥。 */
  openReplyRetrievalDb(dbPath: string, saltPath: string): DerivedCipherDb;
  close(): void;
}

export function createPersonStore(opts: PersonStoreOptions): PersonStore {
  const db = openPersonDb(opts);
  const persons = createPersonsRepo(db);
  const aliases = createAliasesRepo(db);
  const conversations = createConversationsRepo(db);
  const messages = createMessagesRepo(db);
  const staging = createStagingRepo(db);
  const relationships = createRelationshipsRepo(db);
  const events = createEventsRepo(db);
  const metrics = createMetricsRepo(db);
  const replyHistory = createReplyHistoryRepo(db);
  const reviewRequired: ReviewRequiredRepo = createReviewRequiredRepo(db);
  const bus = createPersonsEventBus();
  const deps: IdentityDeps = {
    persons,
    aliases,
    transaction: (fn) => db.transaction(fn)(),
  };
  const commitDeps = {
    staging,
    conversations,
    messages,
    ensurePersonForUid: (input: EnsurePersonForUidInput) => ensurePerson(deps, input),
  };

  return {
    persons,
    aliases,
    conversations,
    messages,
    staging,
    relationships,
    events,
    metrics,
    replyHistory,
    ensurePersonForUid: (input) => ensurePerson(deps, input),
    commitStaged(input: CommitStagedInput): CommitStagedResult {
      const result = db.transaction(() => commitStaged(commitDeps, input))();
      bus.emit({
        kind: "messages_committed",
        occurred_at: input.now,
        batch_id: input.batch_id,
        conversation_ids: [input.conversation_id],
        committed: result.committed,
        skipped: result.skipped,
      });
      return result;
    },
    revertBatch(input: RevertBatchInput): RevertBatchResult {
      const result = db.transaction(() => revertBatch({ staging }, input))();
      bus.emit({
        kind: "batch_reverted",
        occurred_at: input.now,
        batch_id: input.batch_id,
        reverted: result.rejected,
      });
      return result;
    },
    onCommitted: (listener) => bus.onCommitted(listener),
    recentChanges: (limit) => bus.recent(limit),
    getPerson: (personId) => persons.get(personId),
    listPersons: (q) => persons.list(q),
    getMeta: (key) => getPersonMeta(db, key),
    listReviewRequiredConversations: () => reviewRequired.listReviewRequiredConversations(),
    isReviewRequired: (conversationId) => reviewRequired.isReviewRequired(conversationId),
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
    openReplyRetrievalDb(dbPath: string, saltPath: string): DerivedCipherDb {
      return db.openReplyRetrievalDb(dbPath, saltPath);
    },
    close(): void {
      db.close();
    },
  };
}

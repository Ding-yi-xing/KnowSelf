/**
 * @knowself/person-store 公开出口（DESIGN-13 §2.2）。
 * 现状：DDL + db 层 + 加密接入 + 错误类型 + `persons` / `aliases` 仓库 + `store` 门面。
 * 后续工单补：其余 6 个仓库、`merge.ts` / `manual.ts` / `write.ts` / `events.ts`、导出导入（§12）。
 */
export {
  openPersonDb,
  getPersonMeta,
  setPersonMeta,
  DEFAULT_TIMEZONE,
  EXPECTED_SCHEMA_VERSION,
  SELF_PERSON_ID,
} from "./db";
export type { PersonDb, PersonDbEncryption, PersonDbOptions, EncryptionMode } from "./db";

export { DDL_STATEMENTS } from "./ddl.js";
export { COLUMN_MIGRATIONS, META_DEFAULTS, POST_MIGRATION_DDL } from "./ddl/migrations";
export type { ColumnMigration } from "./ddl/migrations";

export {
  applyKey,
  verifyKey,
  rekey,
  deriveReplyRetrievalKey,
  ensureReplyRetrievalSalt,
  openDerivedCipherDb,
  REPLY_RETRIEVAL_INFO,
  REPLY_RETRIEVAL_SALT_BYTES,
  REPLY_RETRIEVAL_KEY_BYTES,
} from "./crypto/cipher";
export type { CipherDbRaw, DerivedCipherDb } from "./crypto/cipher";

export { parseJsonColumn, stringifyJsonColumn } from "./json";

export { createPersonStore } from "./store";
export { mergePersons, MergeRejectedError } from "./merge";
export type { MergePersonsInput, MergePersonsResult } from "./merge";
export type { PersonStore, PersonStoreOptions } from "./store";

export { createPersonsRepo } from "./repository/persons";
export type { PersonsRepo } from "./repository/persons";
export { createAliasesRepo } from "./repository/aliases";
export type { AliasesRepo } from "./repository/aliases";
export { createConversationsRepo } from "./repository/conversations";
export type { ConversationsRepo } from "./repository/conversations";
export { createMembersRepo } from "./repository/members";
export type { MembersRepo } from "./repository/members";
export { createMessagesRepo } from "./repository/messages";
export type { MessagesRepo } from "./repository/messages";
export { createMentionsRepo } from "./repository/mentions";
export type { MentionsRepo } from "./repository/mentions";
export { createTraceRepo } from "./repository/trace";
export type { TraceRepo } from "./repository/trace";
export { createStagingRepo } from "./repository/staging";
export type { StagingRepo } from "./repository/staging";
export { createReviewRequiredRepo } from "./repository/review-required";
export type {
  ReviewRequiredConversation,
  ReviewRequiredRepo,
} from "./repository/review-required";
export { REVERTED_BATCH_GUARD } from "./repository/message-filter";
export { createRelationshipsRepo } from "./repository/relationships";
export type { RelationshipsRepo } from "./repository/relationships";
export { createEventsRepo } from "./repository/events";
export type { EventsRepo } from "./repository/events";
export { createMetricsRepo } from "./repository/metrics";
export type { MetricsRepo } from "./repository/metrics";
export { createReplyHistoryRepo } from "./repository/reply-history";
export type {
  ReplyConversationRow,
  ReplyHistoryMessage,
  ReplyHistoryPage,
  ReplyHistoryRepo,
} from "./repository/reply-history";

export { commitStaged } from "./commit";
export type { CommitDeps, CommitStagedInput, CommitStagedResult } from "./commit";
export { revertBatch } from "./revert";
export type { RevertBatchInput, RevertBatchResult, RevertDeps } from "./revert";

export { createPersonsEventBus } from "./events";
export type {
  PersonsChangeEvent,
  PersonsChangeKind,
  PersonsChangeListener,
  PersonsEventBus,
} from "./events";

export { STAGING_PRUNE_DAYS, TRACE_EXCERPT_CHARS } from "./constants";

export { ensurePersonForUid, normalizeAlias, resolveSenderPersonId } from "./identity";
export type { EnsurePersonForUidInput, EnsurePersonForUidResult, IdentityDeps } from "./identity";

export type {
  AliasCandidateQuery,
  AliasExtractorInput,
  AliasInsert,
  AliasKind,
  AliasListQuery,
  AliasPlatform,
  AliasRow,
  AliasSource,
  AutoWriteResult,
  MergeListQuery,
  MergePerformedBy,
  PersonInsert,
  PersonLite,
  PersonListQuery,
  PersonMergeInsert,
  PersonMergeRow,
  PersonPatch,
  PersonRow,
  PersonStatsPatch,
  PersonStatus,
  SubjectKind,
} from "./types";

export type {
  ChatConversationRow,
  ChatMemberRow,
  ChatMemberUpsert,
  ChatMessageInsert,
  ChatMessageRow,
  ChatPlatform,
  ContentType,
  ConversationKind,
  ConversationUpsert,
  MentionInsert,
  MentionKind,
  MentionRow,
  MessageRole,
  MiningMessageRow,
  RoleInGroup,
  TraceRow,
} from "./types-chat";

export type {
  BatchRow,
  BatchStatus,
  CursorRow,
  ReconcileRow,
  StagingInsert,
  StagingRow,
  StagingStatus,
  StagingTier,
} from "./types-ingest";

export {
  PersonStoreError,
  PersonNotFoundError,
  AliasConflictError,
  MergeForbiddenError,
  ManualLockedError,
  BatchInvalidError,
  CursorRegressionError,
  AppendOnlyViolationError,
  EncryptionModeMismatchError,
  SchemaVersionError,
  ImportForbiddenError,
  ExportBundleError,
  EncryptionKeyMissingError,
  EncryptionKeyInvalidError,
} from "./errors";
export type { PersonStoreErrorCode } from "./errors";

export type {
  DirectionKind,
  RelationshipSource,
  EventScopeKind,
  EventSourceKind,
  FactKind,
  Period,
  IntentKind,
  GraphKind,
  RelationshipRow,
  RelationshipAutoRow,
  RelationshipPatch,
  EventRow,
  EventInsert,
  EventAutoRow,
  EventPatch,
  FactRow,
  FactUpsert,
  MetricRow,
  MetricUpsert,
  IntentRow,
  IntentUpsert,
  GraphSnapshotRow,
  GraphSnapshotInsert,
} from "./types-derive";

import type {
  ChatRequest,
  ChatEvent,
  ConversationId,
  ListConversationsQuery,
  ListConversationsResponse,
  GetConversationResponse,
  ConversationRecord,
  RenameConversationRequest,
  CoreProfileStored,
  CoreProfileInput,
  CardSummary,
  CardKey,
  CardStored,
  CardInput,
  JournalDate,
  JournalDateSummary,
  JournalEntryStored,
  AppSettings,
  PartialAppSettings,
  SystemStatusResponse,
  SourceId,
  SourceStored,
  SourceDetail,
  IngestResponse,
  ProposalId,
  IngestionProposal,
  DecideProposalRequest,
  ImportResponse,
  TemplateRecord,
  TemplatePromptResponse,
} from "@knowself/contracts";

/**
 * Transport — 前端与服务端的唯一通信通道。
 * HTTP 实现见 http.ts，Tauri 占位见 tauri.ts。
 */
export interface Transport {
  /** 流式对话（SSE）。 */
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
  /** 中止指定会话的进行中流式。 */
  abortChat(conversation_id: ConversationId): Promise<{ aborted: boolean }>;

  /** 会话列表。 */
  listConversations(q: ListConversationsQuery): Promise<ListConversationsResponse>;
  /** 单会话详情 + 全部消息。 */
  getConversation(id: ConversationId): Promise<GetConversationResponse>;
  /** 重命名会话。 */
  renameConversation(
    id: ConversationId,
    body: RenameConversationRequest,
  ): Promise<ConversationRecord>;
  /** 删除会话。 */
  deleteConversation(id: ConversationId): Promise<void>;

  /** 读取 L1 核心档案。 */
  getCore(): Promise<CoreProfileStored>;
  /** 写 L1 核心档案。 */
  saveCore(input: CoreProfileInput): Promise<void>;
  /** L2 卡片列表摘要。 */
  listCards(): Promise<CardSummary[]>;
  /** L2 单卡详情（含 sections）。 */
  getCard(key: CardKey): Promise<CardStored>;
  /** 写 L2 整张卡片。 */
  saveCard(key: CardKey, input: Omit<CardInput, "key">): Promise<void>;
  /** 追加 L2 卡片小节。 */
  appendCardSection(key: CardKey, body: { section: string; body: string }): Promise<void>;
  /** L3 有日记的日期列表。 */
  listJournalDates(): Promise<JournalDateSummary[]>;
  /** L3 单日日记详情。 */
  getJournal(date: JournalDate): Promise<JournalEntryStored>;
  /** 追加 L3 日记条目。 */
  appendJournal(date: JournalDate, body: { body: string; tags?: string[] }): Promise<void>;

  /** 读取已 mask 的 settings。 */
  getSettings(): Promise<AppSettings>;
  /** 局部更新 settings。 */
  patchSettings(patch: PartialAppSettings): Promise<AppSettings>;

  /** 系统健康状态快照。 */
  getSystemStatus(): Promise<SystemStatusResponse>;

  // --- 资料 ---
  /** 资料列表。 */
  listSources(query?: { status?: string; kind?: string }): Promise<SourceStored[]>;
  /** 创建资料（file 用 FormData，url/paste 用 JSON）。 */
  createSource(body: SourceCreateInput, onProgress?: (pct: number) => void): Promise<SourceStored>;
  /** 资料详情（含 proposals）。 */
  getSource(id: SourceId): Promise<SourceDetail>;
  /** 删除资料。 */
  deleteSource(id: SourceId): Promise<void>;
  /** 批量删除资料。 */
  deleteSources(ids: SourceId[]): Promise<{ ok: boolean; deleted: number }>;
  /** 触发蒸馏。 */
  runIngest(id: SourceId, body?: { provider_id?: string }): Promise<IngestResponse>;

  /** 查询 proposals（按 source / status 过滤）。 */
  listProposals(query?: { source_id?: string; status?: string }): Promise<IngestionProposal[]>;
  /** 决策 proposal。 */
  decideProposal(id: ProposalId, body: DecideProposalRequest): Promise<IngestionProposal>;

  /** 导出档案（zip / md / json）。 */
  exportProfile(req: {
    format: "zip-full" | "markdown-snapshot" | "json";
  }): Promise<{ path: string }>;

  /** 扫描本地 Ollama 实例，返回可用模型列表。 */
  scanOllama(baseUrl?: string): Promise<{ state: string; models: string[] }>;

  /** V2-06: 导入档案（上传 .zip + mode）。 */
  importProfile(file: File, mode: "replace" | "merge" | "dry-run"): Promise<ImportResponse>;
  /** V2-06: 下载导出文件（浏览器 blob 下载）。 */
  exportDownload(format: string): Promise<Blob>;

  /** V2-05: 模板列表。 */
  listTemplates(): Promise<TemplateRecord[]>;
  /** V2-05: 创建模板。 */
  createTemplate(input: Omit<TemplateRecord, "created_at">): Promise<TemplateRecord>;
  /** V2-05: 删除模板。 */
  deleteTemplate(id: string): Promise<void>;
  /** V2-05: 构建提示词（变量替换）。 */
  buildPrompt(req: {
    template_id: string;
    variable_values: Record<string, string>;
    user_message: string;
  }): Promise<TemplatePromptResponse>;
}

export type SourceCreateInput =
  | { kind: "file"; file: File; original_name: string; user_note?: string }
  | { kind: "url"; url: string; user_note?: string }
  | { kind: "paste"; text: string; original_name?: string };

/**
 * Transport 层统一错误类型。
 * code 对应服务端 ChatEventError.code 或 HTTP 状态语义。
 */
export class TransportError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly trace_id?: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

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
  ListSourcesResponse,
  IngestResponse,
  ProposalId,
  IngestionProposal,
  DecideProposalRequest,
  ImportResponse,
  TemplateRecord,
  TemplatePromptResponse,
} from "@knowself/contracts";
import { TransportError } from "./types";
import { parseSseStream } from "./sse";
import type { Transport } from "./types";

/** 通过 fetch + SSE 实现的 Transport。baseUrl 末尾不含斜杠。 */
export function createHttpTransport(baseUrl: string): Transport {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new TransportError(
        "NETWORK",
        0,
        `网络请求失败: ${e instanceof Error ? e.message : "未知错误"}`,
      );
    }

    if (res.status === 204) return undefined as T;

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new TransportError("PARSE", res.status, `响应 JSON 解析失败: ${res.status}`);
    }

    if (!res.ok) {
      const body = data as Record<string, unknown>;
      throw new TransportError(
        (body.code as string) ?? `HTTP_${res.status}`,
        res.status,
        (body.message as string) ?? `请求失败: ${res.status}`,
        body.trace_id as string | undefined,
      );
    }

    return data as T;
  }

  return {
    // --- 流式 ---
    chat: async function* (req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      const url = `${baseUrl}/api/chat`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...req, stream: true }),
        signal,
      });

      if (!res.ok) {
        let body: Record<string, unknown> = {};
        try {
          body = (await res.json()) as Record<string, unknown>;
        } catch {
          /* ignore parse errors on error responses */
        }
        throw new TransportError(
          (body.code as string) ?? `HTTP_${res.status}`,
          res.status,
          (body.message as string) ?? `对话请求失败: ${res.status}`,
          body.trace_id as string | undefined,
        );
      }

      const reader = res.body?.getReader();
      if (!reader) {
        throw new TransportError("NO_BODY", 500, "响应无可读 body");
      }

      yield* parseSseStream(reader);
    },

    abortChat: (id: ConversationId) => request("POST", `/api/chat/abort`, { conversation_id: id }),

    // --- 会话 ---
    listConversations: (q: ListConversationsQuery) =>
      request<ListConversationsResponse>(
        "GET",
        `/api/conversations?limit=${q.limit}&offset=${q.offset}`,
      ),

    getConversation: (id: ConversationId) =>
      request<GetConversationResponse>("GET", `/api/conversations/${id}`),

    renameConversation: (id: ConversationId, body: RenameConversationRequest) =>
      request<ConversationRecord>("PATCH", `/api/conversations/${id}`, body),

    deleteConversation: (id: ConversationId) => request<void>("DELETE", `/api/conversations/${id}`),

    // --- 档案 ---
    getCore: () => request<CoreProfileStored>("GET", "/api/profile/core"),

    saveCore: (input: CoreProfileInput) =>
      request<void>("PUT", "/api/profile/core", { target: "core", provenance: "user", ...input }),

    listCards: () => request<CardSummary[]>("GET", "/api/profile/cards"),

    getCard: (key: CardKey) => request<CardStored>("GET", `/api/profile/cards/${key}`),

    saveCard: (key: CardKey, input: Omit<CardInput, "key">) =>
      request<void>("PUT", `/api/profile/cards/${key}`, {
        target: "card",
        provenance: "user",
        key,
        ...input,
      }),

    appendCardSection: (key: CardKey, body: { section: string; body: string }) =>
      request<void>("POST", `/api/profile/cards/${key}/sections`, {
        target: "card_section",
        provenance: "user",
        key,
        ...body,
      }),

    listJournalDates: () => request<JournalDateSummary[]>("GET", "/api/profile/journal"),

    getJournal: (date: JournalDate) =>
      request<JournalEntryStored>("GET", `/api/profile/journal/${date}`),

    appendJournal: (date: JournalDate, body: { body: string; tags?: string[] }) =>
      request<void>("POST", `/api/profile/journal`, {
        target: "journal",
        provenance: "user",
        date,
        body: body.body,
        tags: body.tags ?? [],
      }),

    // --- 设置 ---
    getSettings: () => request<AppSettings>("GET", "/api/settings"),

    patchSettings: (patch: PartialAppSettings) =>
      request<AppSettings>("PATCH", "/api/settings", patch),

    // --- 系统 ---
    getSystemStatus: () => request<SystemStatusResponse>("GET", "/api/system/status"),

    // --- 资料 ---
    listSources: (query) => {
      const params = new URLSearchParams();
      if (query?.status) params.set("status", query.status);
      if (query?.kind) params.set("kind", query.kind);
      const qs = params.toString();
      return request<ListSourcesResponse>("GET", `/api/sources${qs ? `?${qs}` : ""}`).then(
        (r) => r.items,
      );
    },

    createSource: async (body, onProgress) => {
      if (body.kind === "file") {
        return new Promise<SourceStored>((resolve, reject) => {
          const fd = new FormData();
          fd.append("file", body.file);
          fd.append("kind", "file");
          fd.append("original_name", body.original_name);
          if (body.user_note) fd.append("note", body.user_note);
          const xhr = new XMLHttpRequest();
          xhr.open("POST", `${baseUrl}/api/sources`);
          xhr.responseType = "json";
          if (onProgress) {
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
            };
          }
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(xhr.response as SourceStored);
            } else {
              const data = xhr.response as Record<string, unknown> | undefined;
              reject(
                new TransportError(
                  (data?.code as string) ?? `HTTP_${xhr.status}`,
                  xhr.status,
                  (data?.message as string) ?? `上传失败: ${xhr.status}`,
                ),
              );
            }
          };
          xhr.onerror = () => reject(new TransportError("NETWORK", 0, "上传网络错误"));
          xhr.send(fd);
        });
      }
      return request<SourceStored>("POST", "/api/sources", body);
    },

    getSource: (id: SourceId) => request<SourceDetail>("GET", `/api/sources/${id}`),

    deleteSource: (id: SourceId) => request<void>("DELETE", `/api/sources/${id}`),

    deleteSources: (ids: SourceId[]) =>
      request<{ ok: boolean; deleted: number }>("POST", `/api/sources/batch-delete`, { ids }),

    runIngest: (id: SourceId, body) =>
      request<IngestResponse>("POST", `/api/sources/${id}/ingest`, body ?? {}),

    listProposals: (query) => {
      const params = new URLSearchParams();
      if (query?.source_id) params.set("source_id", query.source_id);
      if (query?.status) params.set("status", query.status);
      const qs = params.toString();
      return request<IngestionProposal[]>("GET", `/api/proposals${qs ? `?${qs}` : ""}`);
    },

    decideProposal: (id: ProposalId, body: DecideProposalRequest) =>
      request<IngestionProposal>("PATCH", `/api/proposals/${id}/decide`, body),

    // --- 导出 ---
    exportProfile: (req) => request<{ path: string }>("POST", "/api/profile/export", req),

    scanOllama: (baseUrl) =>
      request<{ state: string; models: string[] }>(
        "POST",
        "/api/settings/providers/scan-ollama",
        baseUrl ? { base_url: baseUrl } : undefined,
      ),

    importProfile: async (file, mode) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("mode", mode);
      const url = `${baseUrl}/api/profile/import`;
      const res = await fetch(url, { method: "POST", body: fd });
      if (!res.ok) {
        let data: Record<string, unknown> = {};
        try {
          data = (await res.json()) as Record<string, unknown>;
        } catch {
          /* ignore */
        }
        throw new TransportError(
          (data.code as string) ?? `HTTP_${res.status}`,
          res.status,
          (data.message as string) ?? `导入失败: ${res.status}`,
        );
      }
      return res.json() as Promise<ImportResponse>;
    },

    exportDownload: async (format) => {
      const url = `${baseUrl}/api/profile/export/download?format=${encodeURIComponent(format)}`;
      const res = await fetch(url);
      if (!res.ok) throw new TransportError("DOWNLOAD_FAILED", res.status, "导出文件下载失败");
      return res.blob();
    },

    listTemplates: () => request<TemplateRecord[]>("GET", "/api/templates"),

    createTemplate: (input) => request<TemplateRecord>("POST", "/api/templates", input),

    deleteTemplate: (id) => request<void>("DELETE", `/api/templates/${id}`),

    buildPrompt: (req) =>
      request<TemplatePromptResponse>("POST", "/api/templates/build-prompt", req),
  };
}

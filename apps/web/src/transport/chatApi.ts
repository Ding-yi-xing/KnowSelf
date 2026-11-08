/**
 * Chat 传输客户端 —— 会话管理 REST + 默认 provider 解析 + SSE 流入口。
 *
 * 与 transport/http.ts 的 Inbox REST 客户端并列，互不耦合：
 * `KnowSelfApi` 保持原样（InboxPage 试点页及其测试零改动）。
 * 所有方法在调用时才读取 `globalThis.fetch`，便于测试用 vi.stubGlobal 注入。
 */
import type {
  ChatEvent,
  ChatRequest,
  ConversationRecord,
  GetConversationResponse,
  ListConversationsResponse,
} from "@knowself/contracts";
import {
  CHAT_ABORT_PATH,
  openChatStream,
  type OpenChatStreamOptions,
} from "./sse";

export interface ProviderChoice {
  readonly id: string;
  readonly label: string;
}

export interface ProviderDefaults {
  readonly selectedId: string;
  readonly choices: readonly ProviderChoice[];
}

export interface ChatApi {
  listConversations(params: {
    readonly limit: number;
    readonly offset: number;
  }): Promise<ListConversationsResponse>;
  getConversation(id: string): Promise<GetConversationResponse>;
  renameConversation(id: string, title: string): Promise<ConversationRecord>;
  deleteConversation(id: string): Promise<void>;
  /** 读取 GET /api/settings 并解析默认 chat provider；无法确定时返回 null（UI 显示空态）。 */
  getProviderDefaults(): Promise<ProviderDefaults | null>;
  streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
  /** POST /api/chat/abort，body `{ conversation_id }`；失败按 best-effort 返回 false。 */
  abortChat(conversationId: string): Promise<boolean>;
}

interface RawProvider {
  readonly id: string;
  readonly label: string;
  readonly purposes: readonly string[];
  readonly defaultFor: readonly string[];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * 从 GET /api/settings 的响应中解析默认对话模型。
 *
 * 取值顺序（与 `packages/contracts/src/settings.ts` 的
 * `conversation.default_provider_id` / `ProviderConfig.default_for` 语义一致）：
 *   1. conversation.default_provider_id（非空且确实存在于候选列表）
 *   2. providers[] 中 default_for 含 "chat" 的第一个
 *   3. 候选列表第一个
 * providers 为空 / settings 形状不合法 → 返回 null，绝不返回占位 id。
 */
export function resolveProviderDefaults(settings: unknown): ProviderDefaults | null {
  if (typeof settings !== "object" || settings === null) return null;
  const root = settings as Record<string, unknown>;
  if (!Array.isArray(root.providers)) return null;

  const providers: RawProvider[] = [];
  for (const item of root.providers) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id === "") continue;
    providers.push({
      id: raw.id,
      label: typeof raw.label === "string" && raw.label !== "" ? raw.label : raw.id,
      purposes: stringArray(raw.purposes),
      defaultFor: stringArray(raw.default_for),
    });
  }
  if (providers.length === 0) return null;

  // 契约约定「UI 顶部下拉只列含 chat 的」；缺失 purposes 时宽松视为可用。
  const chatProviders = providers.filter(
    (provider) => provider.purposes.length === 0 || provider.purposes.includes("chat"),
  );
  const source = chatProviders.length > 0 ? chatProviders : providers;
  const choices: ProviderChoice[] = source.map((provider) => ({
    id: provider.id,
    label: provider.label,
  }));

  let selectedId = "";
  const conversation = root.conversation;
  if (typeof conversation === "object" && conversation !== null) {
    const explicit = (conversation as Record<string, unknown>).default_provider_id;
    if (
      typeof explicit === "string" &&
      explicit !== "" &&
      choices.some((choice) => choice.id === explicit)
    ) {
      selectedId = explicit;
    }
  }
  if (selectedId === "") {
    const defaultForChat = providers.find(
      (provider) =>
        provider.defaultFor.includes("chat") &&
        choices.some((choice) => choice.id === provider.id),
    );
    if (defaultForChat !== undefined) selectedId = defaultForChat.id;
  }
  if (selectedId === "") selectedId = choices[0]?.id ?? "";
  if (selectedId === "") return null;

  return { selectedId, choices };
}

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = { method, headers: { Accept: "application/json" } };
  if (body !== undefined) {
    init.headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    init.body = JSON.stringify(body);
  }
  const response = await fetchImpl(`${base}${path}`, init);
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      /* 响应体不可读时保留状态文本 */
    }
    throw new Error(
      `${method} ${path} → ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface CreateChatApiOptions {
  readonly base?: string;
  readonly fetchImpl?: typeof fetch;
}

export function createChatApi(options: CreateChatApiOptions = {}): ChatApi {
  const base = options.base ?? "";
  const getFetch = (): typeof fetch => options.fetchImpl ?? globalThis.fetch;
  const json = <T,>(method: string, path: string, body?: unknown): Promise<T> =>
    fetchJson<T>(getFetch(), base, method, path, body);

  return {
    listConversations: ({ limit, offset }) =>
      json<ListConversationsResponse>(
        "GET",
        `/api/conversations?limit=${limit}&offset=${offset}`,
      ),
    getConversation: (id) =>
      json<GetConversationResponse>(
        "GET",
        `/api/conversations/${encodeURIComponent(id)}`,
      ),
    renameConversation: (id, title) =>
      json<ConversationRecord>(
        "PATCH",
        `/api/conversations/${encodeURIComponent(id)}`,
        { title },
      ),
    deleteConversation: async (id) => {
      await json<{ ok: boolean }>(
        "DELETE",
        `/api/conversations/${encodeURIComponent(id)}`,
      );
    },
    getProviderDefaults: async () => {
      try {
        const settings = await json<unknown>("GET", "/api/settings");
        return resolveProviderDefaults(settings);
      } catch {
        return null;
      }
    },
    streamChat: (request, signal) => {
      const streamOptions: OpenChatStreamOptions = {
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.base !== undefined ? { base: options.base } : {}),
        signal,
      };
      return openChatStream(request, streamOptions);
    },
    abortChat: async (conversationId) => {
      try {
        const result = await json<{ ok: boolean }>("POST", CHAT_ABORT_PATH, {
          conversation_id: conversationId,
        });
        return result.ok === true;
      } catch {
        return false;
      }
    },
  };
}

export const chatApi: ChatApi = createChatApi();

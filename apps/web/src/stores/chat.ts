import { create } from "zustand";
import type {
  ConversationId,
  MessageId,
  ChatHistoryMessage,
  ChatEvent,
  ConversationRecord,
} from "@knowself/contracts";
import { uuidv4 } from "../lib/uuid";
import type { useTransport } from "./transport-context";

// ────────────────────────────────────────────
//  ToolCallTimeline — 工具调用状态机
// ────────────────────────────────────────────

export type ToolCallPhase = "started" | "input_ready" | "executing" | "done" | "error";

export interface ToolCallTimeline {
  tool_use_id: string;
  name: string;
  input?: unknown;
  output?: string;
  is_error?: boolean;
  duration_ms?: number;
  phase: ToolCallPhase;
}

// ────────────────────────────────────────────
//  State shape
// ────────────────────────────────────────────

export type ChatStatus = "idle" | "streaming" | "error" | "aborted";

interface ChatState {
  currentConversationId: ConversationId | null;
  messages: ChatHistoryMessage[];
  streamingMessageId: MessageId | null;
  toolCalls: Record<MessageId, ToolCallTimeline[]>;
  toolsEnabled: Record<string, boolean>;
  status: ChatStatus;
  error: { code: string; message: string } | null;
  abortCtrl: AbortController | null;
  conversations: ConversationRecord[];
  conversationsLoading: boolean;
  writeBackTriggered: boolean;

  setToolsEnabled: (toolId: string, enabled: boolean) => void;
  clearWriteBackTriggered: () => void;
  startConversation: () => ConversationId;
  send: (
    text: string,
    opts: { provider_id: string; tools_enabled: boolean; write_back: boolean },
    transport: ReturnType<typeof useTransport>,
  ) => Promise<void>;
  abort: (transport: ReturnType<typeof useTransport>) => Promise<void>;
  loadConversation: (
    id: ConversationId,
    transport: ReturnType<typeof useTransport>,
  ) => Promise<void>;
  loadConversationList: (transport: ReturnType<typeof useTransport>) => Promise<void>;
  renameConversation: (
    id: ConversationId,
    title: string,
    transport: ReturnType<typeof useTransport>,
  ) => Promise<void>;
  deleteConversation: (
    id: ConversationId,
    transport: ReturnType<typeof useTransport>,
  ) => Promise<void>;
  reset: () => void;
}

// ────────────────────────────────────────────
//  Store
// ────────────────────────────────────────────

export const useChatStore = create<ChatState>((set, get) => ({
  currentConversationId: null,
  messages: [],
  streamingMessageId: null,
  toolCalls: {},
  toolsEnabled: {},
  status: "idle",
  error: null,
  abortCtrl: null,
  conversations: [],
  conversationsLoading: false,
  writeBackTriggered: false,

  clearWriteBackTriggered: () => set({ writeBackTriggered: false }),

  startConversation: () => {
    const id = uuidv4();
    set({
      currentConversationId: id,
      messages: [],
      streamingMessageId: null,
      toolCalls: {},
      status: "idle",
      error: null,
      abortCtrl: null,
      writeBackTriggered: false,
    });
    return id;
  },

  setToolsEnabled: (toolId, enabled) => {
    set({ toolsEnabled: { ...get().toolsEnabled, [toolId]: enabled } });
  },

  send: async (text, opts, transport) => {
    const { currentConversationId, abortCtrl: prevCtrl } = get();
    // abort 上一个进行中的请求
    if (prevCtrl) {
      prevCtrl.abort();
    }

    const ctrl = new AbortController();
    const convId =
      currentConversationId ?? (get().startConversation(), get().currentConversationId!);

    // 追加用户消息
    const userMsg: ChatHistoryMessage = {
      id: uuidv4(),
      conversation_id: convId,
      role: "user",
      content: [{ kind: "text", text }],
      created_at: new Date().toISOString(),
      provider_id: null,
      model: null,
      };

    set({
      messages: [...get().messages, userMsg],
      status: "streaming",
      error: null,
      abortCtrl: ctrl,
      writeBackTriggered: false,
    });

    try {
      const stream = transport.chat(
        {
          conversation_id: convId,
          user_message: text,
          provider_id: opts.provider_id,
          stream: true,
          tools_enabled: opts.tools_enabled,
          write_back: opts.write_back,
        },
        ctrl.signal,
      );

      for await (const event of stream) {
        // 若已被 abort 则跳过后续处理
        if (ctrl.signal.aborted) break;

        applyEvent(get, set, event);
      }

      // 正常结束
      if (!ctrl.signal.aborted && get().status === "streaming") {
        set({ status: "idle", abortCtrl: null });
        get()
          .loadConversationList(transport)
          .catch(() => {});
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        set({ status: "aborted", abortCtrl: null });
        return;
      }
      const message = err instanceof Error ? err.message : "未知错误";
      const code = (err as { code?: string }).code ?? "INTERNAL";
      set({
        status: "error",
        error: { code, message },
        abortCtrl: null,
      });
    }
  },

  abort: async (transport) => {
    const { currentConversationId, abortCtrl } = get();
    if (abortCtrl) {
      abortCtrl.abort();
    }
    if (currentConversationId) {
      try {
        await transport.abortChat(currentConversationId);
      } catch {
        // 服务端 abort 失败也继续本地清理
      }
    }
    set({ status: "aborted", abortCtrl: null });
  },

  loadConversation: async (id, transport) => {
    set({ status: "idle", error: null });
    try {
      const res = await transport.getConversation(id);
      set({
        currentConversationId: id,
        messages: res.messages,
        streamingMessageId: null,
        toolCalls: {},
      });
      get()
        .loadConversationList(transport)
        .catch(() => {});
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "加载失败";
      set({ error: { code: "LOAD_FAILED", message } });
    }
  },

  loadConversationList: async (transport) => {
    set({ conversationsLoading: true });
    try {
      const res = await transport.listConversations({ limit: 50, offset: 0 });
      set({ conversations: res.items, conversationsLoading: false });
    } catch {
      set({ conversationsLoading: false });
    }
  },

  renameConversation: async (id, title, transport) => {
    try {
      await transport.renameConversation(id, { title });
      get()
        .loadConversationList(transport)
        .catch(() => {});
    } catch {
      // silent
    }
  },

  deleteConversation: async (id, transport) => {
    try {
      await transport.deleteConversation(id);
      const { currentConversationId } = get();
      if (currentConversationId === id) {
        get().startConversation();
      }
      get()
        .loadConversationList(transport)
        .catch(() => {});
    } catch {
      // silent
    }
  },

  reset: () => {
    set({
      currentConversationId: null,
      messages: [],
      streamingMessageId: null,
      toolCalls: {},
      toolsEnabled: {},
      status: "idle",
      error: null,
      abortCtrl: null,
      writeBackTriggered: false,
    });
  },
}));

// ────────────────────────────────────────────
//  Event applicator（纯函数，分离自 store 减小函数体）
// ────────────────────────────────────────────

function applyEvent(
  get: () => ChatState,
  set: (partial: Partial<ChatState>) => void,
  event: ChatEvent,
): void {
  const state = get();

  switch (event.type) {
    case "message_start": {
      const assistantMsg: ChatHistoryMessage = {
        id: event.message_id,
        conversation_id: event.conversation_id,
        role: "assistant",
        content: [],
        created_at: event.occurred_at,
        provider_id: null,
        model: null,
      };
      set({
        messages: [...state.messages, assistantMsg],
        streamingMessageId: event.message_id,
      });
      break;
    }

    case "text_delta": {
      const msgs = [...state.messages];
      const idx = msgs.findIndex((m) => m.id === event.message_id);
      if (idx === -1) break;

      const src = msgs[idx]!;
      const msg: typeof src = { ...src };
      const content = [...(msg.content ?? [])];
      const last = content[content.length - 1];
      if (last && last.kind === "text") {
        content[content.length - 1] = {
          ...last,
          text: last.text + event.delta,
        };
      } else {
        content.push({ kind: "text", text: event.delta });
      }
      msg.content = content;
      msgs[idx] = msg;
      set({ messages: msgs });
      break;
    }

    case "tool_use_start": {
      const tc = {
        ...state.toolCalls,
      };
      const list = tc[event.message_id] ?? [];
      tc[event.message_id] = [
        ...list,
        {
          tool_use_id: event.tool_use_id,
          name: event.name,
          phase: "started" as ToolCallPhase,
        },
      ];
      set({ toolCalls: tc });
      break;
    }

    case "tool_use_end": {
      const tc = { ...state.toolCalls };
      const list = (tc[event.message_id] ?? []).map((t) =>
        t.tool_use_id === event.tool_use_id
          ? { ...t, input: event.input, phase: "input_ready" as ToolCallPhase }
          : t,
      );
      tc[event.message_id] = list;
      set({ toolCalls: tc });
      break;
    }

    case "tool_result": {
      const tc = { ...state.toolCalls };
      const list = (tc[event.message_id] ?? []).map((t) =>
        t.tool_use_id === event.tool_use_id
          ? {
              ...t,
              output: event.output,
              is_error: event.is_error,
              duration_ms: event.duration_ms,
              phase: event.is_error ? ("error" as ToolCallPhase) : ("done" as ToolCallPhase),
            }
          : t,
      );
      tc[event.message_id] = list;
      set({ toolCalls: tc });
      break;
    }

    case "message_end": {
      set({ streamingMessageId: null });
      break;
    }

    case "done": {
      if (event.write_back_triggered) {
        set({ writeBackTriggered: true });
      }
      break;
    }

    case "error": {
      // error 事件已在 parseSseStream 层抛 TransportError，这里做兜底
      set({
        error: { code: event.code, message: event.message },
        status: "error",
      });
      break;
    }
  }
}

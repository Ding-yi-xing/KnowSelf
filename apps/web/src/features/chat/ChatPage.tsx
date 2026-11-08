/**
 * ChatPage —— 迁移后的主对话页（按当前独立壳风格重写，零复用旧前端代码）。
 *
 * 用户可见行为：
 *   - 左侧会话列表：GET /api/conversations?limit=&offset=，新建 / 切换 / 重命名 / 删除
 *   - 打开会话读历史 GET /api/conversations/:id，按 ChatHistoryMessage 渲染气泡
 *   - 输入区 Enter 发送 / Shift+Enter 换行，发送中可中止（POST /api/chat/abort）
 *   - SSE 逐块追加助手文本、工具调用气泡、done / error 结束、断链错误可见
 *   - provider 默认值来自 GET /api/settings；读不到时显示明确空态并停用发送
 *   - Ctrl/⌘+N 由 App 通过 ChatCommandContext 下发「新建会话」一次性命令
 */
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type {
  ChatRequest,
  ConversationRecord,
} from "@knowself/contracts";
import { chatApi, type ChatApi, type ProviderDefaults } from "../../transport/chatApi";
import { isAbortError } from "../../transport/sse";
import { Button, EmptyState, ErrorBanner, Spinner } from "../../ui/primitives";
import type { PageId } from "../../routes";
import {
  initialChatViewState,
  reduceChatView,
  type ChatMessageView,
} from "./chatState";
import {
  useChatCommands,
  type ChatCommandState,
} from "./ChatCommandContext";

interface ChatPageProps {
  readonly client?: ChatApi;
  /** 测试可显式注入；生产由 App 的 ChatCommandContext.Provider 提供。 */
  readonly commands?: ChatCommandState;
  readonly onNavigate?: (page: PageId) => void;
}

const LIST_LIMIT = 50;

const ROLE_LABEL: Record<ChatMessageView["role"], string> = {
  user: "你",
  assistant: "助手",
  tool: "工具结果",
};

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 契约要求 conversation_id / message_id 为 UUID v4；crypto 缺失时生成合法 v4。 */
function newUuid(): string {
  const cryptoObj: Crypto | undefined = globalThis.crypto;
  if (cryptoObj !== undefined && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const rand = Math.floor(Math.random() * 16);
    const value = char === "x" ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}

function formatDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function ChatPage({ client = chatApi, commands, onNavigate }: ChatPageProps) {
  const contextCommands = useChatCommands();
  const chatCommands: ChatCommandState = commands ?? contextCommands;

  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [view, dispatch] = useReducer(reduceChatView, initialChatViewState);
  const [provider, setProvider] = useState<ProviderDefaults | null>(null);
  const [providerLoading, setProviderLoading] = useState(true);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [draft, setDraft] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshList = useCallback(async (): Promise<void> => {
    setListLoading(true);
    try {
      const result = await client.listConversations({ limit: LIST_LIMIT, offset: 0 });
      if (!mountedRef.current) return;
      setConversations(result.items);
      setListError(null);
    } catch (cause) {
      if (!mountedRef.current) return;
      setListError(describeError(cause));
    } finally {
      if (mountedRef.current) setListLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    let cancelled = false;
    setProviderLoading(true);
    void client.getProviderDefaults().then((defaults) => {
      if (cancelled || !mountedRef.current) return;
      setProvider(defaults);
      setSelectedProviderId(defaults?.selectedId ?? "");
      setProviderLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const startNewConversation = useCallback((): string => {
    const previous = abortRef.current;
    if (previous !== null) {
      previous.abort();
      abortRef.current = null;
      if (currentId !== null) void client.abortChat(currentId);
    }
    const id = newUuid();
    setCurrentId(id);
    dispatch({ type: "reset" });
    setDraft("");
    setRenamingId(null);
    setConfirmDeleteId(null);
    return id;
  }, [client, currentId]);

  // Ctrl/⌘+N 下发的一次性命令：消费后立刻归零，避免切页回来重复新建。
  useEffect(() => {
    if (chatCommands.newConversationToken > 0) {
      startNewConversation();
      chatCommands.consumeNewConversation();
    }
  }, [
    chatCommands.newConversationToken,
    chatCommands.consumeNewConversation,
    startNewConversation,
  ]);

  const selectConversation = useCallback(
    async (id: string): Promise<void> => {
      const previous = abortRef.current;
      if (previous !== null) {
        previous.abort();
        abortRef.current = null;
      }
      setCurrentId(id);
      dispatch({ type: "reset" });
      try {
        const result = await client.getConversation(id);
        if (!mountedRef.current) return;
        dispatch({ type: "setHistory", messages: result.messages });
      } catch (cause) {
        if (mountedRef.current) {
          dispatch({
            type: "failed",
            code: "LOAD_FAILED",
            message: describeError(cause),
          });
        }
      }
    },
    [client],
  );

  const sendMessage = useCallback(async (): Promise<void> => {
    const text = draft.trim();
    if (text === "" || view.status === "streaming" || abortRef.current !== null) return;
    if (selectedProviderId === "") return;

    const conversationId = currentId ?? newUuid();
    if (currentId === null) setCurrentId(conversationId);

    dispatch({ type: "appendUser", id: newUuid(), text });
    dispatch({ type: "beginAssistant", id: newUuid() });
    setDraft("");

    const controller = new AbortController();
    abortRef.current = controller;

    const request: ChatRequest = {
      conversation_id: conversationId,
      user_message: text,
      provider_id: selectedProviderId,
      stream: true,
      tools_enabled: true,
      write_back: true,
    };

    try {
      for await (const event of client.streamChat(request, controller.signal)) {
        if (controller.signal.aborted) break;
        dispatch({ type: "event", event });
        if (event.type === "done" || event.type === "error") break;
      }
      if (!controller.signal.aborted && abortRef.current === controller) {
        void refreshList();
      }
    } catch (cause) {
      if (isAbortError(cause)) {
        dispatch({ type: "aborted" });
      } else {
        dispatch({
          type: "failed",
          code: "STREAM_ERROR",
          message: describeError(cause),
        });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [draft, view.status, selectedProviderId, currentId, client, refreshList]);

  const abortStream = useCallback((): void => {
    const controller = abortRef.current;
    if (controller === null) return;
    controller.abort();
    abortRef.current = null;
    if (currentId !== null) void client.abortChat(currentId);
    dispatch({ type: "aborted" });
  }, [client, currentId]);

  const submitRename = useCallback(
    async (id: string): Promise<void> => {
      const title = renameDraft.trim();
      if (title === "") {
        setRenamingId(null);
        return;
      }
      try {
        await client.renameConversation(id, title);
        setRenamingId(null);
        await refreshList();
      } catch (cause) {
        setListError(describeError(cause));
      }
    },
    [client, renameDraft, refreshList],
  );

  const confirmDelete = useCallback(
    async (id: string): Promise<void> => {
      try {
        await client.deleteConversation(id);
        setConfirmDeleteId(null);
        if (id === currentId) startNewConversation();
        await refreshList();
      } catch (cause) {
        setListError(describeError(cause));
      }
    },
    [client, currentId, refreshList, startNewConversation],
  );

  useEffect(() => {
    const element = messagesRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [view.messages]);

  const handleComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const activeConversation = conversations.find((item) => item.id === currentId);
  const headerTitle = activeConversation?.title ?? "新会话";
  const providerMissing =
    !providerLoading && (provider === null || selectedProviderId === "");
  const canSend =
    draft.trim() !== "" && view.status !== "streaming" && selectedProviderId !== "";

  return (
    <div className="chat-layout">
      {sidebarOpen && (
        <aside className="chat-sidebar" aria-label="会话列表">
          <div className="chat-sidebar-head">
            <strong>会话</strong>
            <Button
              variant="ghost"
              aria-label="收起会话列表"
              onClick={() => setSidebarOpen(false)}
            >
              ‹
            </Button>
          </div>
          <div className="chat-sidebar-actions">
            <Button variant="primary" onClick={() => startNewConversation()}>
              ＋ 新建会话
            </Button>
          </div>

          <div className="chat-conv-list">
            {listLoading && conversations.length === 0 ? (
              <Spinner label="加载会话列表" />
            ) : listError !== null ? (
              <div className="chat-inline-error" role="alert">
                会话列表加载失败：{listError}
              </div>
            ) : conversations.length === 0 ? (
              <div className="chat-conv-empty">暂无历史会话</div>
            ) : (
              conversations.map((conversation) => (
                <div
                  key={conversation.id}
                  className="chat-conv-item"
                  data-active={conversation.id === currentId}
                >
                  {renamingId === conversation.id ? (
                    <div className="chat-conv-edit">
                      <input
                        className="chat-input"
                        aria-label="会话标题"
                        value={renameDraft}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void submitRename(conversation.id);
                          if (event.key === "Escape") setRenamingId(null);
                        }}
                      />
                      <Button
                        variant="primary"
                        onClick={() => void submitRename(conversation.id)}
                      >
                        保存
                      </Button>
                      <Button onClick={() => setRenamingId(null)}>取消</Button>
                    </div>
                  ) : confirmDeleteId === conversation.id ? (
                    <div className="chat-conv-edit">
                      <span className="card-meta">确认删除？</span>
                      <Button
                        variant="danger"
                        onClick={() => void confirmDelete(conversation.id)}
                      >
                        删除
                      </Button>
                      <Button onClick={() => setConfirmDeleteId(null)}>取消</Button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="chat-conv-select"
                        onClick={() => void selectConversation(conversation.id)}
                      >
                        <span className="chat-conv-title">{conversation.title}</span>
                        <span className="card-meta">
                          {conversation.message_count} 条 ·{" "}
                          {formatDate(conversation.updated_at)}
                        </span>
                      </button>
                      <div className="chat-conv-tools">
                        <button
                          type="button"
                          aria-label={`重命名 ${conversation.title}`}
                          onClick={() => {
                            setRenamingId(conversation.id);
                            setRenameDraft(conversation.title);
                          }}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          aria-label={`删除 ${conversation.title}`}
                          onClick={() => setConfirmDeleteId(conversation.id)}
                        >
                          ✕
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
          <div className="chat-sidebar-foot">Ctrl/⌘+N 新建会话</div>
        </aside>
      )}

      <div className="chat-main">
        <header className="chat-header">
          <button
            type="button"
            className="btn"
            data-variant="ghost"
            aria-label="切换会话列表"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            ☰
          </button>
          <div className="chat-header-title">
            <strong>{headerTitle}</strong>
            <span className="card-meta">{view.messages.length} 条消息</span>
          </div>
          <div className="chat-header-right">
            <label className="chat-provider">
              <span className="card-meta">模型</span>
              <select
                className="chat-select"
                aria-label="对话模型"
                value={selectedProviderId}
                disabled={provider === null || provider.choices.length === 0}
                onChange={(event) => setSelectedProviderId(event.target.value)}
              >
                {provider === null ? (
                  <option value="">未配置</option>
                ) : (
                  provider.choices.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.label}
                    </option>
                  ))
                )}
              </select>
            </label>
          </div>
        </header>

        {view.error !== null && (
          <ErrorBanner message={`${view.error.code}：${view.error.message}`} />
        )}
        {providerMissing && (
          <div className="chat-provider-warning" role="alert">
            尚未配置可用的对话模型，请到「设置」页添加 provider；发送已停用，不会用占位值发起请求。
          </div>
        )}

        <div className="chat-messages" ref={messagesRef} aria-label="消息列表">
          {view.messages.length === 0 ? (
            <EmptyState
              title="开始一段新对话"
              description="输入消息后按 Enter 发送；Shift+Enter 换行；Ctrl/⌘+N 新建会话。"
            />
          ) : (
            <div className="chat-bubbles">
              {view.messages.map((message) => (
                <ChatBubbleView key={message.id} message={message} />
              ))}
            </div>
          )}
        </div>

        {view.writeBackTriggered && (
          <div className="chat-writeback">
            <span>已触发自动回写，蒸馏建议会出现在「待整理」。</span>
            <div>
              <Button
                variant="ghost"
                onClick={() => dispatch({ type: "clearWriteBack" })}
              >
                忽略
              </Button>
              {onNavigate !== undefined && (
                <Button
                  variant="primary"
                  onClick={() => {
                    dispatch({ type: "clearWriteBack" });
                    onNavigate("inbox");
                  }}
                >
                  查看待整理
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="chat-composer">
          <textarea
            className="textarea chat-input-area"
            aria-label="消息输入框"
            placeholder="输入消息…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
          />
          <div className="chat-composer-bar">
            <span className="card-meta">
              Enter 发送 · Shift+Enter 换行 · Ctrl/⌘+N 新建会话
            </span>
            <div className="chat-composer-actions">
              {view.status === "streaming" ? (
                <Button variant="danger" onClick={abortStream}>
                  中止
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={!canSend}
                  onClick={() => void sendMessage()}
                >
                  发送
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatBubbleView({ message }: { message: ChatMessageView }) {
  return (
    <div className="chat-bubble" data-role={message.role}>
      <div className="chat-bubble-role">{ROLE_LABEL[message.role]}</div>
      {message.text !== "" && (
        <div className="chat-bubble-text">{message.text}</div>
      )}
      {message.text === "" && message.streaming && (
        <div className="chat-bubble-text chat-typing">正在生成…</div>
      )}
      {message.toolCalls.length > 0 && (
        <div className="chat-tools">
          {message.toolCalls.map((tool) => (
            <div
              className="chat-tool"
              key={tool.toolUseId}
              data-error={tool.isError}
            >
              <div className="chat-tool-head">
                <strong>{tool.name}</strong>
                <span className="badge" data-tone={tool.isError ? "neutral" : "info"}>
                  {tool.phase}
                </span>
                {tool.durationMs !== null && (
                  <span className="card-meta">{tool.durationMs} ms</span>
                )}
              </div>
              {tool.input !== null && (
                <pre className="chat-tool-code">{safeStringify(tool.input)}</pre>
              )}
              {tool.output !== null && (
                <pre className="chat-tool-code">{tool.output}</pre>
              )}
            </div>
          ))}
        </div>
      )}
      {message.streaming && message.text !== "" && (
        <span className="chat-cursor" aria-hidden="true">▍</span>
      )}
    </div>
  );
}

/**
 * Chat 页 UI 状态机 —— 把 ChatEvent / ChatHistoryMessage 映射为可渲染的视图模型。
 *
 * 纯函数 + useReducer：事件处理逻辑集中在此，便于单测；组件只负责派发与渲染。
 * 事件形状严格取自 `packages/contracts/src/chat.ts` 的 ChatEventSchema。
 */
import type { ChatEvent, ChatHistoryMessage } from "@knowself/contracts";

export type ToolCallPhase = "started" | "input_ready" | "done" | "error";

export interface ToolCallView {
  readonly toolUseId: string;
  readonly name: string;
  readonly input: unknown;
  readonly output: string | null;
  readonly isError: boolean;
  readonly durationMs: number | null;
  readonly phase: ToolCallPhase;
}

export interface ChatMessageView {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  readonly toolCalls: readonly ToolCallView[];
  readonly streaming: boolean;
}

export type ChatStatus = "idle" | "streaming" | "aborted" | "error";

export interface ChatViewState {
  readonly messages: readonly ChatMessageView[];
  /** 当前正在流式追加的 assistant 消息 id。 */
  readonly activeMessageId: string | null;
  readonly status: ChatStatus;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly writeBackTriggered: boolean;
}

export const initialChatViewState: ChatViewState = {
  messages: [],
  activeMessageId: null,
  status: "idle",
  error: null,
  writeBackTriggered: false,
};

export type ChatViewAction =
  | { readonly type: "reset" }
  | { readonly type: "setHistory"; readonly messages: readonly ChatHistoryMessage[] }
  | { readonly type: "appendUser"; readonly id: string; readonly text: string }
  | { readonly type: "beginAssistant"; readonly id: string }
  | { readonly type: "event"; readonly event: ChatEvent }
  | { readonly type: "aborted" }
  | { readonly type: "failed"; readonly code: string; readonly message: string }
  | { readonly type: "clearWriteBack" };

/** 把 GET /api/conversations/:id 返回的 history 转成消息视图。 */
export function messagesFromHistory(
  history: readonly ChatHistoryMessage[],
): ChatMessageView[] {
  return history.map((message) => {
    let text = "";
    const toolCalls: ToolCallView[] = [];

    for (const block of message.content) {
      if (block.kind === "text") {
        text += block.text;
      } else if (block.kind === "tool_use") {
        toolCalls.push({
          toolUseId: block.tool_use_id,
          name: block.name,
          input: block.input,
          output: null,
          isError: false,
          durationMs: null,
          phase: "input_ready",
        });
      } else {
        const index = toolCalls.findIndex(
          (tool) => tool.toolUseId === block.tool_use_id,
        );
        const phase: ToolCallPhase = block.is_error ? "error" : "done";
        if (index >= 0) {
          const current = toolCalls[index];
          if (current !== undefined) {
            toolCalls[index] = {
              ...current,
              output: block.output,
              isError: block.is_error,
              phase,
            };
          }
        } else {
          toolCalls.push({
            toolUseId: block.tool_use_id,
            name: "工具结果",
            input: null,
            output: block.output,
            isError: block.is_error,
            durationMs: null,
            phase,
          });
        }
        // tool 角色的 content 只有 tool_result，正文直接展示其输出。
        if (message.role === "tool") text += block.output;
      }
    }

    return {
      id: message.id,
      role: message.role,
      text,
      toolCalls,
      streaming: false,
    };
  });
}

function stopStreaming(state: ChatViewState): ChatViewState {
  return {
    ...state,
    activeMessageId: null,
    messages: state.messages.map((message) =>
      message.streaming ? { ...message, streaming: false } : message,
    ),
  };
}

/** 找到事件应追加到的 assistant 消息：优先 activeMessageId，其次事件自带 message_id。 */
function withActiveMessage(
  state: ChatViewState,
  eventMessageId: string | null,
  update: (message: ChatMessageView) => ChatMessageView,
): ChatViewState {
  const activeIndex =
    state.activeMessageId === null
      ? -1
      : state.messages.findIndex((message) => message.id === state.activeMessageId);
  const fallbackIndex =
    eventMessageId === null
      ? -1
      : state.messages.findIndex((message) => message.id === eventMessageId);
  const target = activeIndex >= 0 ? activeIndex : fallbackIndex;
  if (target < 0) return state;

  const current = state.messages[target];
  if (current === undefined) return state;
  const messages = [...state.messages];
  messages[target] = update(current);
  return { ...state, messages };
}

/** 单个 ChatEvent 对视图状态的影响（done / error 为会话级终止）。 */
export function applyChatEvent(
  state: ChatViewState,
  event: ChatEvent,
): ChatViewState {
  switch (event.type) {
    case "message_start": {
      const activeIndex =
        state.activeMessageId === null
          ? -1
          : state.messages.findIndex((m) => m.id === state.activeMessageId);
      if (activeIndex >= 0) {
        const messages = [...state.messages];
        const current = messages[activeIndex];
        if (current !== undefined) {
          messages[activeIndex] = { ...current, id: event.message_id };
        }
        return { ...state, messages, activeMessageId: event.message_id };
      }
      return {
        ...state,
        status: "streaming",
        activeMessageId: event.message_id,
        messages: [
          ...state.messages,
          {
            id: event.message_id,
            role: "assistant",
            text: "",
            toolCalls: [],
            streaming: true,
          },
        ],
      };
    }

    case "text_delta":
      return withActiveMessage(state, event.message_id, (message) => ({
        ...message,
        text: message.text + event.delta,
      }));

    case "tool_use_start":
      return withActiveMessage(state, event.message_id, (message) => ({
        ...message,
        toolCalls: [
          ...message.toolCalls,
          {
            toolUseId: event.tool_use_id,
            name: event.name,
            input: null,
            output: null,
            isError: false,
            durationMs: null,
            phase: "started",
          },
        ],
      }));

    case "tool_use_end":
      return withActiveMessage(state, event.message_id, (message) => ({
        ...message,
        toolCalls: message.toolCalls.map((tool) =>
          tool.toolUseId === event.tool_use_id
            ? {
                ...tool,
                input: event.input,
                phase: "input_ready" as ToolCallPhase,
              }
            : tool,
        ),
      }));

    case "tool_result":
      return withActiveMessage(state, event.message_id, (message) => ({
        ...message,
        toolCalls: message.toolCalls.map((tool) =>
          tool.toolUseId === event.tool_use_id
            ? {
                ...tool,
                output: event.output,
                isError: event.is_error,
                durationMs: event.duration_ms,
                phase: (event.is_error ? "error" : "done") as ToolCallPhase,
              }
            : tool,
        ),
      }));

    case "message_end":
      // 服务端可能回到 message_start 进入下一轮 LLM 续写，故不在此结束流式态。
      return state;

    case "done":
      return {
        ...stopStreaming(state),
        status: "idle",
        writeBackTriggered: event.write_back_triggered,
      };

    case "error":
      return {
        ...stopStreaming(state),
        status: "error",
        error: { code: event.code, message: event.message },
      };

    default:
      return state;
  }
}

export function reduceChatView(
  state: ChatViewState,
  action: ChatViewAction,
): ChatViewState {
  switch (action.type) {
    case "reset":
      return initialChatViewState;
    case "setHistory":
      return { ...initialChatViewState, messages: messagesFromHistory(action.messages) };
    case "appendUser":
      return {
        ...state,
        error: null,
        writeBackTriggered: false,
        messages: [
          ...state.messages,
          {
            id: action.id,
            role: "user",
            text: action.text,
            toolCalls: [],
            streaming: false,
          },
        ],
      };
    case "beginAssistant":
      return {
        ...state,
        status: "streaming",
        error: null,
        activeMessageId: action.id,
        messages: [
          ...state.messages,
          {
            id: action.id,
            role: "assistant",
            text: "",
            toolCalls: [],
            streaming: true,
          },
        ],
      };
    case "event":
      return applyChatEvent(state, action.event);
    case "aborted":
      return { ...stopStreaming(state), status: "aborted" };
    case "failed":
      return {
        ...stopStreaming(state),
        status: "error",
        error: { code: action.code, message: action.message },
      };
    case "clearWriteBack":
      return { ...state, writeBackTriggered: false };
    default:
      return state;
  }
}

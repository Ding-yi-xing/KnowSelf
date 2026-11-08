/**
 * 新建会话命令通道 —— 让 App 的 Ctrl/⌘+N 全局快捷键把「新建会话」传给 ChatPage。
 *
 * 最小实现：一个递增 token 作为一次性命令，ChatPage 消费后调用 consume 归零。
 * 不引入任何状态库；Provider 由 App 挂在壳根部，ChatPage 通过 hook 读取。
 * 未提供 Provider 时返回明确的 no-op 默认值，便于 ChatPage 独立渲染/测试。
 */
import { createContext, useContext } from "react";

export interface ChatCommandState {
  /** > 0 表示有一次待消费的「新建会话」请求。 */
  readonly newConversationToken: number;
  readonly requestNewConversation: () => void;
  readonly consumeNewConversation: () => void;
}

export const NOOP_CHAT_COMMANDS: ChatCommandState = {
  newConversationToken: 0,
  requestNewConversation: () => {},
  consumeNewConversation: () => {},
};

export const ChatCommandContext =
  createContext<ChatCommandState>(NOOP_CHAT_COMMANDS);

export function useChatCommands(): ChatCommandState {
  return useContext(ChatCommandContext);
}

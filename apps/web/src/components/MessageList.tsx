/**
 * MessageList — 渲染消息列表，含流式追加 + 自动滚动到底。
 */
import { useEffect, useRef } from "react";
import { Sparkles } from "lucide-react";
import { useChatStore } from "../stores/chat";
import { ChatBubble } from "./ChatBubble";
import { EmptyState } from "./ui/empty-state";
import { useT } from "../lib/i18n";

export function MessageList() {
  const t = useT();
  const messages = useChatStore((s) => s.messages);
  const streamingId = useChatStore((s) => s.streamingMessageId);
  const toolCalls = useChatStore((s) => s.toolCalls);
  const status = useChatStore((s) => s.status);

  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  // 自动滚到底（仅当用户没主动滑离底部）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || userScrolledUpRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingId]);

  // 检测用户主动上滑
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = distanceFromBottom > 80;
  };

  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<Sparkles className="size-6" strokeWidth={1.8} />}
          title={t("chat.empty.title")}
          description={t("chat.empty.desc")}
        />
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      data-testid="chat-status"
      data-status={status}
      className="flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-6 py-6">
        {messages.map((msg) => {
          const tc = toolCalls[msg.id];
          return (
            <ChatBubble
              key={msg.id}
              message={msg}
              isStreaming={msg.id === streamingId}
              {...(tc ? { toolCalls: tc } : {})}
            />
          );
        })}
        {/* aborted 状态尾标 */}
        {status === "aborted" && (
          <div className="mt-1 px-1.5 text-center text-[12px] text-[var(--color-fg-subtle)]">
            {t("chat.aborted")}
          </div>
        )}
      </div>
    </div>
  );
}

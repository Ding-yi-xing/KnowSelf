/**
 * ChatPage — 主对话界面。
 * 顶部操作栏 + 消息列表 + 输入区。
 */
import { useState, useEffect } from "react";
import { PanelLeftClose, PanelLeft, AlertCircle, Sparkles } from "lucide-react";
import { useChatStore } from "../stores/chat";
import { useInboxStore } from "../stores/inbox";
import { Button } from "../components/ui/button";
import { MessageList } from "../components/MessageList";
import { Composer } from "../components/Composer";
import { ConversationList } from "../components/ConversationList";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { useTransport } from "../stores/transport-context";
import type { PageId } from "../components/AppLayout";

interface ChatPageProps {
  onNavigate?: (page: PageId) => void;
}

export function ChatPage({ onNavigate }: ChatPageProps) {
  const t = useT();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const convId = useChatStore((s) => s.currentConversationId);
  const startConversation = useChatStore((s) => s.startConversation);
  const error = useChatStore((s) => s.error);
  const messages = useChatStore((s) => s.messages);
  const writeBackTriggered = useChatStore((s) => s.writeBackTriggered);
  const clearWriteBackTriggered = useChatStore((s) => s.clearWriteBackTriggered);
  const loadInbox = useInboxStore((s) => s.load);
  const transport = useTransport();

  // 完成提示出现后自动刷新收件箱角标
  useEffect(() => {
    if (writeBackTriggered) {
      void loadInbox(transport);
    }
  }, [writeBackTriggered, loadInbox, transport]);

  useEffect(() => {
    if (!convId) startConversation();
  }, [convId, startConversation]);

  return (
    <div className="flex h-full min-h-0">
      {/* 侧栏 */}
      <div
        className={cn(
          "shrink-0 overflow-hidden border-r border-[var(--color-border-subtle)]",
          "transition-[width] duration-[var(--duration-normal)] ease-[var(--ease-standard)]",
          sidebarOpen ? "w-[240px]" : "w-0",
        )}
      >
        <ConversationList open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      </div>

      {/* 主区域 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶部条 */}
        <header
          className={cn(
            "flex shrink-0 items-center justify-between gap-3",
            "border-b border-[var(--color-border-subtle)] bg-[var(--color-bg)]",
            "px-6 py-3",
          )}
        >
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold tracking-[-0.005em]">
              {t("chat.title")}
            </h1>
            <p className="text-[11.5px] tracking-[0.02em] text-[var(--color-fg-subtle)]">
              {messages.length === 0
                ? t("chat.subtitle.empty")
                : t("chat.subtitle.count", { n: String(messages.length) })}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setSidebarOpen((v) => !v)}
            iconLeft={
              sidebarOpen ? (
                <PanelLeftClose className="size-3.5" strokeWidth={2.4} />
              ) : (
                <PanelLeft className="size-3.5" strokeWidth={2.4} />
              )
            }
          >
            {sidebarOpen ? t("chat.sidebar.collapse") : t("chat.sidebar.history")}
          </Button>
        </header>

        {/* 错误条 */}
        {error && (
          <div
            className={cn(
              "fade-in shrink-0 border-b border-[var(--color-danger)]/20",
              "bg-[var(--color-danger-soft)] px-6 py-2.5",
              "flex items-center gap-2 text-[13px] text-[var(--color-danger)]",
            )}
          >
            <AlertCircle className="size-4 shrink-0" strokeWidth={2.2} />
            <span className="min-w-0 truncate font-medium">{error.code}</span>
            <span className="min-w-0 flex-1 truncate opacity-80">{error.message}</span>
          </div>
        )}

        {/* 消息列表 */}
        <MessageList />

        {/* 对话完成后「已提取建议」提示 */}
        {writeBackTriggered && (
          <div className="shrink-0 border-t border-[var(--color-accent)]/20 bg-[var(--color-accent-soft)] px-6 py-3">
            <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <Sparkles className="size-4 shrink-0 text-[var(--color-accent)]" strokeWidth={2} />
                <span className="text-[13px] font-medium text-[var(--color-fg)]">
                  {t("chat.done_hint")}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => {
                    clearWriteBackTriggered();
                    onNavigate?.("inbox");
                  }}
                >
                  {t("chat.done_hint_action")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearWriteBackTriggered}
                >
                  {t("chat.done_hint_dismiss")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* 输入区 */}
        <Composer />
      </div>
    </div>
  );
}

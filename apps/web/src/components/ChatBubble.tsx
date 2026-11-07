/**
 * ChatBubble — 用户 / 助手消息气泡。
 *
 * Apple 路线：用户气泡 = Apple Blue 实色；助手气泡 = 浅灰底，靠字体重量与留白。
 * 流式光标用 .streaming-cursor 工具类。
 */
import type { ChatHistoryMessage } from "@knowself/contracts";
import type { ToolCallTimeline } from "../stores/chat";
import { cn } from "../lib/cn";
import { MarkdownView } from "./MarkdownView";
import { ToolCallBubble } from "./ToolCallBubble";

interface ChatBubbleProps {
  message: ChatHistoryMessage;
  isStreaming?: boolean;
  toolCalls?: ToolCallTimeline[];
}

export function ChatBubble({ message, isStreaming = false, toolCalls }: ChatBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex w-full px-1.5", isUser ? "justify-end" : "justify-start")}>
      <div
        data-testid={isUser ? "message-bubble-user" : "message-bubble-assistant"}
        className={cn(
          "max-w-[78%] min-w-0 fade-in",
          "px-4 py-2.5 text-[14.5px] leading-[1.55]",
          isUser
            ? cn(
                "rounded-[18px] rounded-br-[6px]",
                "bg-[var(--color-accent)] text-white",
                "shadow-[var(--shadow-xs)]",
              )
            : cn(
                "rounded-[18px] rounded-bl-[6px]",
                "bg-[var(--color-bg-muted)] text-[var(--color-fg)]",
              ),
        )}
      >
        {/* 正文 */}
        {message.content.map((block, i) => {
          if (block.kind === "text") {
            if (isUser) {
              return (
                <p key={i} className="whitespace-pre-wrap">
                  {block.text}
                </p>
              );
            }
            return (
              <MarkdownView
                key={i}
                text={block.text}
                className={cn(
                  "prose-sm",
                  "[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
                  "[&_pre]:my-2 [&_pre]:rounded-[var(--radius-md)] [&_pre]:bg-[var(--color-bg)] [&_pre]:p-3 [&_pre]:text-[12.5px]",
                  "[&_code]:font-mono [&_code]:text-[12.5px]",
                  "[&_a]:text-[var(--color-accent)] [&_a]:underline-offset-2 hover:[&_a]:underline",
                  "[&_ul]:my-1.5 [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:pl-5",
                  "[&_li]:my-0.5",
                )}
              />
            );
          }
          return null;
        })}

        {/* 流式光标 */}
        {isStreaming && (
          <span
            className={cn("streaming-cursor", isUser ? "!bg-white/80" : "!bg-[var(--color-fg)]")}
          />
        )}

        {/* 工具调用 */}
        {toolCalls && toolCalls.length > 0 && (
          <div
            className={cn(
              "mt-2.5 space-y-1.5 border-t pt-2.5",
              isUser ? "border-white/15" : "border-[var(--color-border-subtle)]",
            )}
          >
            {toolCalls.map((tc) => (
              <ToolCallBubble key={tc.tool_use_id} tool={tc} dark={isUser} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

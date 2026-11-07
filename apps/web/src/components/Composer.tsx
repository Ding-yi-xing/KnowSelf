/**
 * Composer — 消息输入区。
 *
 * 视觉：模糊大输入框，工具栏内嵌底部，发送按钮右下角圆形。
 * 交互：Enter 发送 / Shift+Enter 换行；自适应高度（max 240）；
 *       发送/中断按钮原地切换；快捷键提示在右下角。
 */
import {
  useState,
  useCallback,
  useRef,
  useEffect,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { ArrowUp, Square, Wrench, Power } from "lucide-react";
import { useChatStore } from "../stores/chat";
import { useTransport } from "../stores/transport-context";
import { useSettingsStore } from "../stores/settings";
import { cn } from "../lib/cn";
import { ProviderPicker } from "./ProviderPicker";
import { TemplatePicker } from "./TemplatePicker";
import { useT } from "../lib/i18n";

const MIN_HEIGHT = 56;
const MAX_HEIGHT = 240;

interface ToolItem {
  id: string;
  label: string;
}

const AVAILABLE_TOOLS: ToolItem[] = [
  { id: "fetch__fetch", label: "Fetch" },
  { id: "chrome-devtools__take_snapshot", label: "chat.tool.screenshot" },
];

export function Composer() {
  const t = useT();
  const [text, setText] = useState("");
  const settings = useSettingsStore((s) => s.settings);
  const [providerId, setProviderId] = useState(() => {
    return settings?.providers?.[0]?.id ?? "";
  });
  const send = useChatStore((s) => s.send);
  const abort = useChatStore((s) => s.abort);
  const status = useChatStore((s) => s.status);
  const toolsEnabled = useChatStore((s) => s.toolsEnabled);
  const setToolsEnabled = useChatStore((s) => s.setToolsEnabled);
  const toolCalls = useChatStore((s) => s.toolCalls);
  const transport = useTransport();
  const isStreaming = status === "streaming";
  const hasActiveToolCalls = Object.values(toolCalls).some((calls) =>
    calls.some(
      (tc) => tc.phase === "started" || tc.phase === "input_ready" || tc.phase === "executing",
    ),
  );

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // settings 异步加载完成后自动选第一个 provider
  useEffect(() => {
    if (!providerId && settings?.providers?.length) {
      setProviderId(settings.providers[0]!.id);
    }
  }, [settings?.providers, providerId]);

  // 自适应高度
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, el.scrollHeight));
    el.style.height = `${next}px`;
  }, [text]);

  const handleSubmit = useCallback(
    (e?: FormEvent) => {
      e?.preventDefault();
      const trimmed = text.trim();
      if (!trimmed || isStreaming || !providerId) return;
      const pid = providerId;
      const anyToolEnabled =
        AVAILABLE_TOOLS.length === 0 || AVAILABLE_TOOLS.some((t) => toolsEnabled[t.id] ?? true);
      void send(
        trimmed,
        { provider_id: pid, tools_enabled: anyToolEnabled, write_back: true },
        transport,
      );
      setText("");
    },
    [text, providerId, isStreaming, toolsEnabled, send, transport],
  );

  const handleAbort = useCallback(() => {
    void abort(transport);
  }, [abort, transport]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const canSend = text.trim().length > 0 && !isStreaming;

  return (
    <form
      onSubmit={(e) => handleSubmit(e)}
      className="shrink-0 border-t border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-6 pb-5 pt-4"
    >
      <div className="mx-auto max-w-3xl">
        <div
          className={cn(
            "group relative rounded-[var(--radius-lg)] border bg-[var(--color-bg)]",
            "border-[var(--color-border)]",
            "transition-[border-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
            "focus-within:border-[var(--color-accent)] focus-within:shadow-[var(--shadow-focus)]",
          )}
        >
          {/* 工具开关行 */}
          {AVAILABLE_TOOLS.length > 0 && (
            <div
              className={cn(
                "flex items-center gap-1 px-3 pt-2 pb-1",
                hasActiveToolCalls && "opacity-50 pointer-events-none",
              )}
            >
              <Wrench className="size-3.5 shrink-0 text-[var(--color-fg-muted)]" />
              {AVAILABLE_TOOLS.map((tool) => {
                const enabled = toolsEnabled[tool.id] ?? true;
                return (
                  <button
                    key={tool.id}
                    type="button"
                    disabled={hasActiveToolCalls}
                    onClick={() => setToolsEnabled(tool.id, !enabled)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-2 py-0.5 text-[11px] font-medium",
                      "transition-[background-color,color] duration-[var(--duration-fast)]",
                      "disabled:cursor-not-allowed",
                      enabled
                        ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                        : "bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)]",
                    )}
                  >
                    <Power className={cn("size-3", enabled && "text-[var(--color-accent)]")} />
                    {t(tool.label)}
                  </button>
                );
              })}
            </div>
          )}

          <textarea
            ref={textareaRef}
            data-testid="chat-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("chat.input.placeholder")}
            disabled={isStreaming}
            rows={1}
            style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
            className={cn(
              "block w-full resize-none bg-transparent",
              "px-4 pt-2 pb-12 text-[14.5px] leading-[1.55] text-[var(--color-fg)]",
              "placeholder:text-[var(--color-fg-subtle)]",
              "focus:outline-none",
              "disabled:cursor-not-allowed disabled:text-[var(--color-fg-subtle)]",
            )}
          />

          {/* 底部工具栏 */}
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 px-3 pb-2.5">
            <div className="flex items-center gap-2">
              <TemplatePicker onInsert={(text) => setText(text)} />
              <ProviderPicker value={providerId} onChange={setProviderId} disabled={isStreaming} />
            </div>

            <div className="flex items-center gap-3">
              <span className="hidden text-[11px] text-[var(--color-fg-subtle)] sm:inline">
                <Kbd>Enter</Kbd> {t("chat.kbd.send")} <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd>{" "}
                {t("chat.kbd.newline")}
              </span>
              {isStreaming ? (
                <button
                  type="button"
                  onClick={handleAbort}
                  data-testid="chat-abort"
                  aria-label={t("chat.abort.aria")}
                  className={cn(
                    "grid size-8 place-items-center rounded-full",
                    "bg-[var(--color-fg)] text-[var(--color-bg)]",
                    "transition-opacity hover:opacity-85",
                    "shadow-[var(--shadow-xs)]",
                  )}
                >
                  <Square className="size-3.5 fill-current" strokeWidth={0} />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!canSend}
                  data-testid="chat-send"
                  aria-label={t("chat.send.aria")}
                  className={cn(
                    "grid size-8 place-items-center rounded-full",
                    "transition-[background-color,opacity] duration-[var(--duration-fast)]",
                    canSend
                      ? "bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] shadow-[var(--shadow-xs)]"
                      : "bg-[var(--color-bg-muted)] text-[var(--color-fg-subtle)] cursor-not-allowed",
                  )}
                >
                  <ArrowUp className="size-4" strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className={cn(
        "mx-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center",
        "rounded-[4px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)]",
        "px-1 font-sans text-[10px] font-medium text-[var(--color-fg-muted)]",
      )}
    >
      {children}
    </kbd>
  );
}

import { useEffect, useRef, useState, useCallback } from "react";
import { Search, Command, MessageSquare, Settings, FileText, User, SunMoon } from "lucide-react";
import { useChatStore } from "../stores/chat";
import { useTheme } from "../hooks/useTheme";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";
import type { PageId } from "./AppLayout";

interface CommandItem {
  id: string;
  label: string;
  icon: typeof MessageSquare;
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (page: PageId) => void;
}

const THEME_CYCLE: Array<"light" | "dark" | "system"> = ["light", "dark", "system"];

export function CommandPalette({ open, onClose, onNavigate }: CommandPaletteProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const startConversation = useChatStore((s) => s.startConversation);
  const { theme, setTheme } = useTheme();

  const commands: CommandItem[] = [
    {
      id: "new-chat",
      label: t("command_palette.new_chat"),
      icon: MessageSquare,
      shortcut: "⌘N",
      action: () => {
        startConversation();
        onNavigate("chat");
        onClose();
      },
    },
    {
      id: "settings",
      label: t("command_palette.settings"),
      icon: Settings,
      action: () => {
        onNavigate("settings");
        onClose();
      },
    },
    {
      id: "sources",
      label: t("command_palette.sources"),
      icon: FileText,
      action: () => {
        onNavigate("sources");
        onClose();
      },
    },
    {
      id: "profile",
      label: t("command_palette.profile"),
      icon: User,
      action: () => {
        onNavigate("profile");
        onClose();
      },
    },
    {
      id: "theme",
      label: t("command_palette.toggle_theme"),
      icon: SunMoon,
      action: () => {
        const idx = THEME_CYCLE.indexOf(theme);
        const nextIdx = idx === -1 ? 0 : (idx + 1) % THEME_CYCLE.length;
        setTheme(THEME_CYCLE[nextIdx]!);
        onClose();
      },
    },
  ];

  const filtered = query.trim() ? commands.filter((c) => c.label.includes(query.trim())) : commands;

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIdx((prev) => (prev + 1) % filtered.length);
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIdx((prev) => (prev - 1 + filtered.length) % filtered.length);
          break;
        case "Enter":
          e.preventDefault();
          filtered[selectedIdx]?.action();
          break;
        case "Escape":
          onClose();
          break;
      }
    },
    [filtered, selectedIdx, onClose],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]" onClick={onClose}>
      <div className="fixed inset-0 bg-[var(--color-bg-overlay)]" />
      <div
        className="relative w-full max-w-[520px] overflow-hidden rounded-[var(--radius-xl)] bg-[var(--color-bg)] shadow-[var(--shadow-lg)] border border-[var(--color-border-subtle)] slide-up"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label={t("command_palette.title")}
      >
        <div className="flex items-center gap-3 border-b border-[var(--color-border-subtle)] px-4 py-3">
          <Search className="size-4 shrink-0 text-[var(--color-fg-subtle)]" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent text-[15px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] outline-none"
            placeholder={t("command_palette.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="hidden items-center gap-0.5 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-subtle)] sm:inline-flex">
            <Command className="size-3" strokeWidth={2} />K
          </kbd>
        </div>

        <div className="max-h-[280px] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-[13px] text-[var(--color-fg-subtle)]">
              {t("command_palette.empty")}
            </div>
          ) : (
            filtered.map((cmd, idx) => {
              const Icon = cmd.icon;
              return (
                <button
                  key={cmd.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-left text-[14px]",
                    "transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
                    idx === selectedIdx
                      ? "bg-[var(--color-accent-soft)] text-[var(--color-fg)]"
                      : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]",
                  )}
                  onClick={() => cmd.action()}
                  onMouseEnter={() => setSelectedIdx(idx)}
                >
                  <Icon
                    className={cn(
                      "size-4 shrink-0",
                      idx === selectedIdx
                        ? "text-[var(--color-accent)]"
                        : "text-[var(--color-fg-subtle)]",
                    )}
                    strokeWidth={2}
                  />
                  <span className="flex-1">{cmd.label}</span>
                  {cmd.shortcut && (
                    <kbd
                      className={cn(
                        "rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-muted)] px-1.5 py-0.5 text-[10px]",
                        idx === selectedIdx
                          ? "text-[var(--color-accent)]"
                          : "text-[var(--color-fg-subtle)]",
                      )}
                    >
                      {cmd.shortcut}
                    </kbd>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * AppLayout — 侧栏 + 主区。
 * 侧栏：品牌标 + 主导航 + 系统状态 pill。
 * 视觉：极轻浮起感，不靠强烈对比。
 */
import { type ReactNode, useEffect } from "react";
import {
  MessageSquareText,
  Inbox,
  User,
  Layers,
  CalendarDays,
  Settings,
  Activity,
  FileText,
  FileSpreadsheet,
  Sun,
  Moon,
  MonitorSmartphone,
} from "lucide-react";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";
import { StatusPill } from "./StatusPill";
import { useSystemStore } from "../stores/system";
import { useTheme } from "../hooks/useTheme";
import { useInboxStore } from "../stores/inbox";
import { useTransport } from "../stores/transport-context";

export type PageId =
  | "chat"
  | "inbox"
  | "profile"
  | "cards"
  | "journal"
  | "settings"
  | "system"
  | "sources"
  | "templates";

/** 主导航 — AI 代录核心流程 */
const PRIMARY_NAV: { id: PageId; labelKey: string; icon: typeof MessageSquareText }[] = [
  { id: "chat", labelKey: "nav.chat", icon: MessageSquareText },
  { id: "inbox", labelKey: "nav.inbox", icon: Inbox },
  { id: "profile", labelKey: "nav.profile", icon: User },
  { id: "sources", labelKey: "nav.sources", icon: FileText },
];

/** 次要导航 — 手填功能（降级，可折叠） */
const SECONDARY_NAV: { id: PageId; labelKey: string; icon: typeof MessageSquareText }[] = [
  { id: "cards", labelKey: "nav.cards", icon: Layers },
  { id: "journal", labelKey: "nav.journal", icon: CalendarDays },
  { id: "templates", labelKey: "nav.templates", icon: FileSpreadsheet },
  { id: "settings", labelKey: "nav.settings", icon: Settings },
  { id: "system", labelKey: "nav.system", icon: Activity },
];

interface AppLayoutProps {
  currentPage: PageId;
  onNavigate: (page: PageId) => void;
  children: ReactNode;
}

export function AppLayout({ currentPage, onNavigate, children }: AppLayoutProps) {
  const t = useT();
  const status = useSystemStore((s) => s.status);
  const { theme, setTheme } = useTheme();
  const pendingCount = useInboxStore((s) => s.pending.length);
  const loadInbox = useInboxStore((s) => s.load);
  const transport = useTransport();

  useEffect(() => {
    void loadInbox(transport);
  }, [loadInbox, transport]);

  // 推断系统聚合健康度（与 SystemPage 使用同一来源：ready.overall）
  const overallState = (() => {
    if (!status) return "starting" as const;
    return status.ready.overall ? ("healthy" as const) : ("starting" as const);
  })();

  return (
    <div className="flex h-screen bg-[var(--color-bg)] text-[var(--color-fg)]">
      {/* 侧栏 */}
      <aside className="flex w-[212px] shrink-0 flex-col border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)]">
        {/* 品牌区 */}
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-4">
          <BrandMark />
          <span className="text-[15px] font-semibold tracking-[-0.01em]">knowSelf</span>
        </div>

        {/* 导航 */}
        <nav className="flex-1 overflow-y-auto px-2.5 pt-1">
          {/* 主导航 */}
          <ul className="space-y-0.5">
            {PRIMARY_NAV.map((item) => {
              const active = currentPage === item.id;
              const Icon = item.icon;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onNavigate(item.id)}
                    aria-current={active ? "page" : undefined}
                    data-testid={`nav-${item.id}`}
                    className={cn(
                      "group flex w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 py-2",
                      "text-[13.5px] font-medium",
                      "transition-[background-color,color] duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
                      active
                        ? "bg-[var(--color-bg)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]"
                        : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-fg)]",
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-[17px] shrink-0",
                        active
                          ? "text-[var(--color-accent)]"
                          : "text-[var(--color-fg-subtle)] group-hover:text-[var(--color-fg-muted)]",
                      )}
                      strokeWidth={2}
                    />
                    <span>{t(item.labelKey)}</span>
                    {item.id === "inbox" && pendingCount > 0 && (
                      <span className="ml-auto flex size-5 items-center justify-center rounded-full bg-[var(--color-danger)] text-[10px] font-semibold text-white">
                        {pendingCount > 99 ? "99+" : pendingCount}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          {/* 分隔 */}
          <div className="my-2 mx-2.5 h-px bg-[var(--color-border-subtle)]" />

          {/* 次要导航 */}
          <ul className="space-y-0.5">
            {SECONDARY_NAV.map((item) => {
              const active = currentPage === item.id;
              const Icon = item.icon;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onNavigate(item.id)}
                    aria-current={active ? "page" : undefined}
                    data-testid={`nav-${item.id}`}
                    className={cn(
                      "group flex w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 py-2",
                      "text-[13.5px] font-medium",
                      "transition-[background-color,color] duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
                      active
                        ? "bg-[var(--color-bg)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]"
                        : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-fg)]",
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-[17px] shrink-0",
                        active
                          ? "text-[var(--color-accent)]"
                          : "text-[var(--color-fg-subtle)] group-hover:text-[var(--color-fg-muted)]",
                      )}
                      strokeWidth={2}
                    />
                    <span>{t(item.labelKey)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* 底部状态 */}
        <div
          className={cn(
            "mx-2.5 mb-2.5 flex items-center justify-between gap-2",
            "rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-bg)]",
            "px-2.5 py-1.5",
          )}
        >
          <StatusPill state={overallState} />
          <ThemeToggle theme={theme} onChange={setTheme} />
        </div>
      </aside>

      {/* 主区 */}
      <main className="flex flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}

/** 主题三态切换：light → dark → system → light。 */
function ThemeToggle({
  theme,
  onChange,
}: {
  theme: "light" | "dark" | "system";
  onChange: (mode: "light" | "dark" | "system") => void;
}) {
  const next: Record<typeof theme, typeof theme> = {
    light: "dark",
    dark: "system",
    system: "light",
  };
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : MonitorSmartphone;
  const t = useT();
  const labelMap: Record<typeof theme, string> = {
    light: t("theme.light"),
    dark: t("theme.dark"),
    system: t("theme.system"),
  };

  return (
    <button
      type="button"
      onClick={() => onChange(next[theme])}
      title={t("theme.toggle.title", { v: labelMap[theme] })}
      aria-label={t("theme.toggle.aria", { v: labelMap[theme] })}
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-[var(--radius-sm)]",
        "text-[var(--color-fg-subtle)]",
        "transition-[background-color,color] duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
        "hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]",
      )}
    >
      <Icon className="size-3.5" strokeWidth={2} />
    </button>
  );
}

/** 简易品牌图标。圆角方块 + Apple Blue 渐变。 */
function BrandMark() {
  return (
    <span
      className="grid size-7 place-items-center rounded-[8px]"
      style={{
        background: "linear-gradient(135deg, var(--color-accent) 0%, #5fb8ff 100%)",
        boxShadow: "0 1px 3px rgba(0, 113, 227, 0.32)",
      }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        className="size-4 text-white"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 12h6l2 -3l2 6l2 -3h4" />
      </svg>
    </span>
  );
}

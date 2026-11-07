/**
 * App — 根组件，含基于 useState 的页面路由。
 */
import { useState, useCallback, useEffect, useRef } from "react";
import type { FC } from "react";
import { AppLayout } from "./components/AppLayout";
import type { PageId } from "./components/AppLayout";
import { ChatPage } from "./pages/ChatPage";
import { InboxPage } from "./pages/InboxPage";
import { ProfilePage } from "./pages/ProfilePage";
import { CardsPage } from "./pages/CardsPage";
import { JournalPage } from "./pages/JournalPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SystemPage } from "./pages/SystemPage";
import { SourcesPage } from "./pages/SourcesPage";
import { TemplatesPage } from "./pages/TemplatesPage";
import { useTheme } from "./hooks/useTheme";
import { CommandPalette } from "./components/CommandPalette";
import { useChatStore } from "./stores/chat";
import { useTransport } from "./stores/transport-context";
import { useSettingsStore } from "./stores/settings";
import { usePollSystemStatus } from "./hooks/usePollSystemStatus";

const PAGE_MAP: Record<PageId, FC> = {
  chat: ChatPage,
  inbox: InboxPage,
  profile: ProfilePage,
  cards: CardsPage,
  journal: JournalPage,
  settings: SettingsPage,
  system: SystemPage,
  sources: SourcesPage,
  templates: TemplatesPage,
};

/** URL pathname → PageId 映射 */
const PATH_TO_PAGE: Record<string, PageId> = {
  "/": "chat",
  "/chat": "chat",
  "/inbox": "inbox",
  "/profile": "profile",
  "/cards": "cards",
  "/journal": "journal",
  "/settings": "settings",
  "/system": "system",
  "/sources": "sources",
  "/templates": "templates",
};

/** PageId → URL pathname 映射 */
const PAGE_TO_PATH: Record<PageId, string> = {
  chat: "/",
  inbox: "/inbox",
  profile: "/profile",
  cards: "/cards",
  journal: "/journal",
  settings: "/settings",
  system: "/system",
  sources: "/sources",
  templates: "/templates",
};

/** 从当前 URL 推断初始页面 */
function pageFromUrl(): PageId {
  return PATH_TO_PAGE[window.location.pathname] ?? "chat";
}

export function App() {
  // ═══ Bootstrap: 首次挂载加载 settings + 启动系统状态轮询 ═══
  const transport = useTransport();
  const booted = useRef(false);
  if (!booted.current) {
    booted.current = true;
    void useSettingsStore.getState().load(transport);
  }
  usePollSystemStatus(5000);

  // 顶层挂一次：确保任何页面切换主题后，<html.dark> 立即生效
  useTheme();

  const [currentPage, setCurrentPage] = useState<PageId>(pageFromUrl);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const startConversation = useChatStore((s) => s.startConversation);

  const handleNavigate = useCallback((page: PageId) => {
    setCurrentPage(page);
    const path = PAGE_TO_PATH[page];
    if (window.location.pathname !== path) {
      window.history.pushState(null, "", path);
    }
  }, []);

  // 浏览器后退/前进
  useEffect(() => {
    const onPopState = () => {
      setCurrentPage(pageFromUrl());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // 全局键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      } else if (mod && e.key === "n") {
        e.preventDefault();
        startConversation();
        setCurrentPage("chat");
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [startConversation]);

  const PageComponent = PAGE_MAP[currentPage];

  return (
    <>
      <AppLayout currentPage={currentPage} onNavigate={handleNavigate}>
        {currentPage === "chat" ? (
          <ChatPage onNavigate={handleNavigate} />
        ) : (
          <PageComponent />
        )}
      </AppLayout>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={handleNavigate}
      />
    </>
  );
}

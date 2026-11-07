/**
 * App —— 独立壳根组件。
 *
 * 保持迁移前的用户可见行为：
 *   - 9 条 URL 路由 + 浏览器前进/后退
 *   - Ctrl/⌘+K 命令面板、Ctrl/⌘+N 回到对话、Esc 关闭
 *   - 主题（localStorage `knowself-theme` / 系统偏好）
 *   - 每 5s 轮询 /api/system/status（失败静默降级为「服务离线」）
 * 实现全部重写，不引用旧前端任何模块。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "./shell/AppShell";
import { NAV_ITEMS, labelForPage, pageFromLocation, pathForPage, type PageId } from "./routes";
import { InboxPage } from "./features/inbox/InboxPage";
import { PlaceholderPage } from "./features/placeholder/PlaceholderPage";
import { api } from "./transport/http";

type Theme = "light" | "dark";

const THEME_KEY = "knowself-theme";

function readTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function App() {
  const [currentPage, setCurrentPage] = useState<PageId>(() =>
    pageFromLocation(window.location.pathname),
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [online, setOnline] = useState<boolean | null>(null);

  const navigate = useCallback((page: PageId) => {
    setCurrentPage(page);
    const path = pathForPage(page);
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    setPaletteOpen(false);
    setPaletteQuery("");
  }, []);

  useEffect(() => {
    const onPopState = () => setCurrentPage(pageFromLocation(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (mod && event.key.toLowerCase() === "n") {
        event.preventDefault();
        navigate("chat");
      } else if (event.key === "Escape") {
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  useEffect(() => {
    const apply = (next: Theme) => {
      document.documentElement.classList.toggle("dark", next === "dark");
      setTheme(next);
    };
    const onSchemeChange = (event: MediaQueryListEvent) => {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "system" || saved === null) apply(event.matches ? "dark" : "light");
    };
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", onSchemeChange);
    return () => media.removeEventListener("change", onSchemeChange);
  }, []);

  const toggleTheme = useCallback(() => {
    const next: Theme = readTheme() === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    localStorage.setItem(THEME_KEY, next);
    setTheme(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        await api.systemStatus();
        if (!cancelled) setOnline(true);
      } catch {
        if (!cancelled) setOnline(false);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const matches = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    return NAV_ITEMS.filter((item) => q === "" || item.label.includes(q) || item.path.includes(q));
  }, [paletteQuery]);

  return (
    <>
      <AppShell
        currentPage={currentPage}
        onNavigate={navigate}
        theme={theme}
        onToggleTheme={toggleTheme}
        online={online}
        paletteOpen={paletteOpen}
      >
        {currentPage === "inbox" ? (
          <InboxPage />
        ) : (
          <PlaceholderPage page={currentPage} onNavigate={navigate} />
        )}
      </AppShell>

      {paletteOpen && (
        <div
          className="palette-backdrop"
          onClick={() => setPaletteOpen(false)}
          role="presentation"
        >
          <div className="palette card" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="命令面板">
            <input
              className="textarea"
              style={{ minHeight: 40 }}
              autoFocus
              placeholder="输入页面名称跳转…"
              value={paletteQuery}
              onChange={(event) => setPaletteQuery(event.target.value)}
            />
            <div className="palette-list">
              {matches.map((item) => (
                <button
                  key={item.id}
                  className="nav-item"
                  onClick={() => navigate(item.id)}
                >
                  <span>{item.label}</span>
                  <span className="card-meta">{item.path}</span>
                </button>
              ))}
              {matches.length === 0 && <div className="card-meta" style={{ padding: 12 }}>无匹配页面</div>}
            </div>
            <div className="card-meta" style={{ padding: "0 4px 4px" }}>
              {labelForPage(currentPage)} · Ctrl/⌘+K 开关 · Esc 关闭
            </div>
          </div>
        </div>
      )}
    </>
  );
}

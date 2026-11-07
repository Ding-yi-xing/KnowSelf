/**
 * 应用外壳 —— 侧栏导航 + 顶栏 + 内容区。
 * 布局与迁移前一致（左侧 9 项导航、顶栏标题、内容区滚动），
 * 实现按 dsh client-web 的 shell/slot 划分重写，不复用旧 AppLayout。
 */
import type { ReactNode } from "react";
import { NAV_ITEMS, labelForPage, type PageId } from "../routes";
import { Badge, NavGlyph } from "../ui/primitives";

export interface AppShellProps {
  readonly currentPage: PageId;
  readonly onNavigate: (page: PageId) => void;
  readonly theme: "light" | "dark";
  readonly onToggleTheme: () => void;
  readonly online: boolean | null;
  readonly paletteOpen: boolean;
  readonly children: ReactNode;
}

export function AppShell({
  currentPage,
  onNavigate,
  theme,
  onToggleTheme,
  online,
  paletteOpen,
  children,
}: AppShellProps) {
  return (
    <div className="shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand">
          <span className="brand-mark">K</span>
          <span>
            knowSelf<br />
            <span className="brand-sub">个人画像</span>
          </span>
        </div>

        <nav className="nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className="nav-item"
              data-active={item.id === currentPage}
              data-page={item.id}
              onClick={() => onNavigate(item.id)}
              title={item.label}
              aria-current={item.id === currentPage ? "page" : undefined}
            >
              <NavGlyph path={item.glyph} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          deepseek-harness 壳 · B1
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <span className="topbar-title">{labelForPage(currentPage)}</span>
          <span className="topbar-hint" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {online !== null && (
              <Badge tone={online ? "success" : "neutral"}>
                {online ? "服务在线" : "服务离线"}
              </Badge>
            )}
            <button className="btn" data-variant="ghost" onClick={onToggleTheme} title="切换主题">
              {theme === "dark" ? "☀" : "☾"}
            </button>
            {paletteOpen && <Badge tone="info">命令面板</Badge>}
          </span>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

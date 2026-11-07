/**
 * 路由表 —— 保持迁移前的 9 条 URL 与页面标识不变。
 * 迁移前由 `App.tsx` 内联定义；此处按 dsh client 的「声明式路由清单」习惯独立成模块，
 * 但 URL、默认页与历史前进/后退行为逐条对齐。
 */

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

export interface NavItem {
  readonly id: PageId;
  readonly path: string;
  readonly label: string;
  /** 自绘 SVG path（24x24 viewBox），不引入图标库。 */
  readonly glyph: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: "chat", path: "/", label: "对话", glyph: "M4 5h16v10H8l-4 4V5z" },
  { id: "inbox", path: "/inbox", label: "待整理", glyph: "M3 5h18v14H3V5zm0 9h5l1 2h6l1-2h5" },
  { id: "profile", path: "/profile", label: "画像", glyph: "M12 12a4 4 0 100-8 4 4 0 000 8zm-8 8a8 8 0 0116 0" },
  { id: "cards", path: "/cards", label: "卡片", glyph: "M4 4h16v16H4V4zm4 4h8M8 12h8M8 16h5" },
  { id: "journal", path: "/journal", label: "日志", glyph: "M5 3h14v18H5V3zm4 4h6M9 11h6M9 15h4" },
  { id: "settings", path: "/settings", label: "设置", glyph: "M12 9a3 3 0 100 6 3 3 0 000-6zm9 3l-2-1 1-2-2-2-2 1-1-2h-3l-1 2-2-1-2 2 1 2-2 1v3l2 1-1 2 2 2 2-1 1 2h3l1-2 2 1 2-2-1-2 2-1v-3z" },
  { id: "system", path: "/system", label: "系统", glyph: "M4 4h16v6H4V4zm0 10h16v6H4v-6zm3-7h2m-2 10h2" },
  { id: "sources", path: "/sources", label: "资料", glyph: "M3 7h6l2 2h10v10H3V7zm0 4h18" },
  { id: "templates", path: "/templates", label: "模板", glyph: "M4 4h16v4H4V4zm0 6h7v10H4V10zm9 0h7v10h-7V10z" },
];

const PATH_TO_PAGE: Readonly<Record<string, PageId>> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.path, item.id]),
) as Readonly<Record<string, PageId>>;

const PAGE_TO_PATH: Readonly<Record<PageId, string>> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.id, item.path]),
) as Readonly<Record<PageId, string>>;

/** 迁移前 `/chat` 也映射到对话页，保持该历史 URL 可用。 */
const LEGACY_ALIASES: Readonly<Record<string, PageId>> = { "/chat": "chat" };

export function pageFromLocation(pathname: string): PageId {
  return PATH_TO_PAGE[pathname] ?? LEGACY_ALIASES[pathname] ?? "chat";
}

export function pathForPage(page: PageId): string {
  return PAGE_TO_PATH[page] ?? "/";
}

export function labelForPage(page: PageId): string {
  return NAV_ITEMS.find((item) => item.id === page)?.label ?? "对话";
}

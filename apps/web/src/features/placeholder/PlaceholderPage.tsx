/**
 * 迁移占位页 —— 9 页中已有 6 页完成迁移（chat / inbox / system / templates / cards / journal），
 * 余下 profile / sources / settings 保留路由与导航，页面内容明确标注尚未迁移。
 * 用户可见行为：点击侧栏能切换、URL 变化、前进/后退有效（与迁移前一致）。
 */
import { labelForPage, pathForPage, type PageId } from "../../routes";
import { Button, Card, PageHeader } from "../../ui/primitives";

/** 已完成功能迁移的页面；占位页只在其余 3 页渲染。 */
const MIGRATED_PAGES: ReadonlySet<PageId> = new Set<PageId>([
  "chat", "inbox", "system", "templates", "cards", "journal",
]);

const PENDING = ["profile", "sources", "settings"] as const;

const SCOPE: Readonly<Record<PageId, string>> = {
  chat: "多会话列表、SSE 流式输出、工具调用气泡、中止、模型选择。",
  inbox: "pending 提案的接受 / 编辑 / 拒绝。",
  profile: "核心画像查看与编辑、导出/导入、画像统计。",
  cards: "画像卡片列表、分区编辑、增删改。",
  journal: "按日期浏览与追加日志记录。",
  settings: "模型供应商、MCP 服务、主题与通用偏好设置。",
  system: "系统状态、运行时诊断与健康检查。",
  sources: "资料上传、列表、详情、批量删除与蒸馏触发。",
  templates: "模板列表、创建与删除。",
};

export function PlaceholderPage({
  page,
  onNavigate,
}: {
  page: PageId;
  onNavigate: (page: PageId) => void;
}) {
  return (
    <div className="content-inner">
      <PageHeader
        title={labelForPage(page)}
        subtitle={`路由 ${pathForPage(page)} · ${
          MIGRATED_PAGES.has(page) ? "已迁移" : "功能迁移排期中"
        }`}
      />
      <Card>
        <div className="placeholder">
          <strong>该页面尚未迁移到新前端基础</strong>
          <span>原功能范围：{SCOPE[page]}</span>
          <span>
            已迁移 6 页：对话、待整理、系统、模板、卡片、日志；
            尚余 {PENDING.length} 页（画像 / 资料 / 设置）为功能占位，按同一壳逐页迁移，
            路由与导航行为已保持与迁移前一致。
          </span>
          <code>deepseek-harness / apps/web (B1 裁剪独立壳)</code>
          <div style={{ marginTop: 8 }}>
            <Button variant="primary" onClick={() => onNavigate("inbox")}>
              查看已迁移的「待整理」
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

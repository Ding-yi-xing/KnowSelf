/**
 * 迁移占位页 —— 其余 8 个页面在本轮「先骨架 + 试点页」节奏中保留路由与导航，
 * 页面内容标注原功能范围，待后续逐页迁移。
 * 用户可见行为：点击侧栏能切换、URL 变化、前进/后退有效（与迁移前一致）。
 */
import { labelForPage, pathForPage, type PageId } from "../../routes";
import { Button, Card, PageHeader } from "../../ui/primitives";

const SCOPE: Readonly<Record<PageId, string>> = {
  chat: "多会话对话、流式输出、工具调用气泡、模型选择、消息编辑与中止。",
  inbox: "（本轮已迁移为试点页）",
  profile: "核心画像查看与编辑、导出/导入、画像统计。",
  cards: "画像卡片列表、分区编辑、增删改。",
  journal: "按日期浏览与编辑日志条目。",
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
        subtitle={`路由 ${pathForPage(page)} · 功能迁移排期中`}
      />
      <Card>
        <div className="placeholder">
          <strong>该页面尚未迁移到新前端基础</strong>
          <span>原功能范围：{SCOPE[page]}</span>
          <span>
            本轮交付「独立壳 + 待整理试点页」；其余页面按同一壳逐页迁移，
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

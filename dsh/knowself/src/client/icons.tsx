/**
 * 侧栏面板图标（A2）——对应 `sidebar.panellist` list slot 的 occupant。
 *
 * 组件只接收 dsh 下发的 owner props `{ size, active }`（A2-核实.md §1.1 / §1.2），
 * 另由 client 入口通过闭包注入 `onSelect`（触发 `ctx.layout.selectPanel`）。
 * 不引入任何 UI 组件库 / 图标库，用原生 button + 文字字形，避免新增依赖。
 */
import type { ReactElement } from "react";
import type { SidebarPanelIconOwnerProps } from "@knowself/dsh-client-contract";

/** 通用图标 props。 */
export interface PanelIconProps extends SidebarPanelIconOwnerProps {
  /** 点击回调（由 apply 闭包绑定 `ctx.layout.selectPanel`）。 */
  onSelect: () => void;
  /** 图标字形（文字，避免图标库依赖）。 */
  glyph: string;
  /** 无障碍标签 / tooltip。 */
  title: string;
}

/** 通用侧栏图标实现。 */
export function PanelIcon({
  size,
  active,
  onSelect,
  glyph,
  title,
}: PanelIconProps): ReactElement {
  return (
    <button
      type="button"
      aria-label={title}
      aria-pressed={active}
      title={title}
      onClick={onSelect}
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.max(12, Math.floor(size * 0.5)),
        lineHeight: 1,
        cursor: "pointer",
        borderRadius: 6,
        border: "1px solid",
        borderColor: active ? "#2563eb" : "transparent",
        background: active ? "#eff6ff" : "transparent",
        color: active ? "#1d4ed8" : "inherit",
        padding: 0,
      }}
    >
      {glyph}
    </button>
  );
}

/** 「KnowSelf」统一入口侧栏图标（人物/画像/待整理/日志/资料）。 */
export interface HubPanelIconProps extends SidebarPanelIconOwnerProps {
  onSelect: () => void;
}

export function HubPanelIcon(props: HubPanelIconProps): ReactElement {
  return <PanelIcon {...props} glyph="K" title="KnowSelf" />;
}

/** 「人物档案」侧栏图标。 */
export interface PersonPanelIconProps extends SidebarPanelIconOwnerProps {
  onSelect: () => void;
}

export function PersonPanelIcon(props: PersonPanelIconProps): ReactElement {
  return <PanelIcon {...props} glyph="人" title="人物档案" />;
}

/** 「知识图谱」侧栏图标。 */
export interface GraphPanelIconProps extends SidebarPanelIconOwnerProps {
  onSelect: () => void;
}

export function GraphPanelIcon(props: GraphPanelIconProps): ReactElement {
  return <PanelIcon {...props} glyph="图" title="知识图谱" />;
}

/** 「画像」侧栏图标（M3）。 */
export interface ProfilePanelIconProps extends SidebarPanelIconOwnerProps {
  onSelect: () => void;
}

export function ProfilePanelIcon(props: ProfilePanelIconProps): ReactElement {
  return <PanelIcon {...props} glyph="像" title="画像" />;
}

/** 「日志」侧栏图标（M3）。 */
export interface JournalPanelIconProps extends SidebarPanelIconOwnerProps {
  onSelect: () => void;
}

export function JournalPanelIcon(props: JournalPanelIconProps): ReactElement {
  return <PanelIcon {...props} glyph="志" title="日志" />;
}

/** 「待整理」侧栏图标（M3 波 2）。 */
export interface InboxPanelIconProps extends SidebarPanelIconOwnerProps {
  onSelect: () => void;
}

export function InboxPanelIcon(props: InboxPanelIconProps): ReactElement {
  return <PanelIcon {...props} glyph="待" title="待整理" />;
}

/** 「资料」侧栏图标（M3 波 2）。 */
export interface SourcesPanelIconProps extends SidebarPanelIconOwnerProps {
  onSelect: () => void;
}

export function SourcesPanelIcon(props: SourcesPanelIconProps): ReactElement {
  return <PanelIcon {...props} glyph="料" title="资料" />;
}

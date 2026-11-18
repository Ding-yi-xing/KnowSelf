/**
 * brand / 面板标识常量（A2）。
 *
 * 本模块是**运行时自给自足**的：`brandString` 是对 `@deepseek-ai/dsh-brand` 的
 * `brandString<MainPanelId>()` 的本地等价实现——brand 仅编译期存在，运行期返回原字符串
 * （A2-核实.md §1.1 / 主理人核实结论 3）。这样 client 入口不 import 任何
 * `@deepseek-ai/dsh-client-ui-*` 或 `@deepseek-ai/dsh-brand` 运行时包，
 * 浏览器 bundle 不引入 Node 侧依赖。
 */
import type { MainPanelId } from "@knowself/dsh-client-contract";

/**
 * 把普通字符串标记为 branded 类型（编译期 branded，运行期 identity）。
 * @param value 面板 id 字符串
 * @returns 同一字符串，静态类型为 T
 */
export function brandString<T extends string>(value: string): T {
  return value as T;
}

/**
 * KnowSelf 统一入口面板 id。
 *
 * 人物 / 画像 / 待整理 / 日志 / 资料收进这一个主面板，用顶部 tab 切换；侧栏只
 * 保留「KnowSelf」一个图标（加独立的知识图谱）。
 */
export const HUB_PANEL_ID: MainPanelId = brandString<MainPanelId>("knowself-hub");

/** 人物档案面板 id（main 的 key / sidebar.panellist 的 id 共用同一字符串）。 */
export const PERSON_PANEL_ID: MainPanelId = brandString<MainPanelId>("knowself-person");

/** 知识图谱面板 id（A2-2 最小占位）。 */
export const GRAPH_PANEL_ID: MainPanelId = brandString<MainPanelId>("knowself-graph");

/** 画像（L1 core / L2 cards）面板 id（M3，只读）。 */
export const PROFILE_PANEL_ID: MainPanelId = brandString<MainPanelId>("knowself-profile");

/** 日志（L3 journal）面板 id（M3，只读）。 */
export const JOURNAL_PANEL_ID: MainPanelId = brandString<MainPanelId>("knowself-journal");

/** 待整理（inbox / 待审提案）面板 id（M3 波 2，只读）。 */
export const INBOX_PANEL_ID: MainPanelId = brandString<MainPanelId>("knowself-inbox");

/** 资料（sources）面板 id（M3 波 2，只读）。 */
export const SOURCES_PANEL_ID: MainPanelId = brandString<MainPanelId>("knowself-sources");

/** 侧栏 label 的 locale 命名空间（A2-核实.md §1.2 的 `locale: NS`）。 */
export const KNOWSELF_LOCALE_NS = "knowself";

/** 侧栏「KnowSelf」统一入口 label（locale 感知函数）。 */
export const HUB_PANEL_LABEL = (): string => "KnowSelf";

/** 侧栏「人物」label（locale 感知函数返回中文；接入 dsh locale 后可替换为 t()）。 */
export const PERSON_PANEL_LABEL = (): string => "人物";

/** 侧栏「图谱」label。 */
export const GRAPH_PANEL_LABEL = (): string => "图谱";

/** 侧栏「画像」label。 */
export const PROFILE_PANEL_LABEL = (): string => "画像";

/** 侧栏「日志」label。 */
export const JOURNAL_PANEL_LABEL = (): string => "日志";

/** 侧栏「待整理」label（M3 波 2）。 */
export const INBOX_PANEL_LABEL = (): string => "待整理";

/** 侧栏「资料」label（M3 波 2）。 */
export const SOURCES_PANEL_LABEL = (): string => "资料";

/**
 * 「KnowSelf」统一入口的当前 tab（模块级状态）。
 *
 * ## 为什么 tab 状态不在 `ctx.layout` 里
 * dsh 的主面板 keyed by `activePanelId`，**一次只挂载一个**；如果切 tab 走
 * `ctx.layout.selectPanel(...)`，每切一次都会整块卸载/重挂，侧栏「KnowSelf」
 * 的选中态也会跟着丢。tab 是同一入口内部的二级导航，不是主面板切换。
 *
 * 所以状态放在模块级：
 *   - 顶部 tab 点击 → `openHubTab(id)`，已挂载的 hub 监听后原地换内容；
 *   - 其它面板跳进来（图谱点人、人物空态去导入资料）→ `openHubTab(id)` +
 *     `selectPanel(HUB_PANEL_ID)`；
 *   - 从图谱切回 KnowSelf 时沿用上次停留的 tab。
 *
 * 这是纯客户端内存状态，刷新/重启后回到默认「人物」。
 */

/** 统一入口的 tab 标识（与各面板的 main key 解耦，避免把导航语义塞进面板 id）。 */
export type HubTabId = "person" | "profile" | "inbox" | "journal" | "sources";

/** 默认 tab：侧栏点进 KnowSelf / 重启后的落点。 */
export const DEFAULT_HUB_TAB: HubTabId = "person";

/** 当前 tab（模块级，跨 hub 挂载保留）。 */
let currentTab: HubTabId = DEFAULT_HUB_TAB;

/** 已挂载 hub 的监听器。 */
const listeners = new Set<(tab: HubTabId) => void>();

/**
 * 打开指定 tab。
 *
 * 已挂载的 hub 会同步收到通知并切过去；未挂载时只更新模块状态，下一次挂载
 * 直接落在这个 tab。
 *
 * @param tab 目标 tab
 */
export function openHubTab(tab: HubTabId): void {
  currentTab = tab;
  for (const listener of listeners) listener(tab);
}

/**
 * 读取当前 tab（hub 挂载时用作初始值）。
 *
 * @returns 当前 tab
 */
export function currentHubTab(): HubTabId {
  return currentTab;
}

/**
 * 订阅 tab 切换事件（hub 挂载期间调用）。
 *
 * @param listener 收到新 tab 的回调
 * @returns 取消订阅函数（组件卸载时调用）
 */
export function subscribeHubTab(listener: (tab: HubTabId) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 清空模块级状态（**仅供测试**在用例之间复位）。
 */
export function resetHubTabForTest(): void {
  currentTab = DEFAULT_HUB_TAB;
  listeners.clear();
}

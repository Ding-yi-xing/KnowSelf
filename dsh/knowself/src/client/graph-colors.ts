/**
 * 图谱**节点配色**（纯函数，零依赖、零 DOM，可在 node 里直接单测）。
 *
 * ## 为什么单独成模块
 * 「按社区上色」是 Obsidian Graph View 的 Groups 能力，配色只跟 `community_key` 有关；
 * 而 `graph-canvas.ts` 还承担绘制（边 / 点 / 标签），把色板塞进去会让它同时依赖
 * `ui-tokens`。抽出来后：
 *   - 配色可被 canvas（画点）与 legend（色点说明）两处复用，且色板只有一个真相源；
 *   - 测试不碰 canvas，也能断言「未分组灰」「同键同色」。
 *
 * ## 色板来源
 * 刻意复用 `ui-tokens.ts` 的 {@link avatarColor}：它是一组**验过白字对比度 ≥4.5:1** 的
 * 固定色板，且同 seed 恒同色（跨面板一致）。本模块不 import React 运行时——`ui-tokens`
 * 里的 React 类型只在编译期被擦除，运行期零依赖。
 */
import { avatarColor } from "./ui-tokens.js";

/** 未分组 / 孤儿节点的中性灰（与设计稿 `.grp` 里「未分组」的 `#94a3b8` 一致）。 */
export const UNGROUPED_COLOR = "#94a3b8";

/**
 * 社区键 → 稳定颜色。
 *
 * @param key `community_key`（`c:<sha1>`）；`null` / 空串视为未分组 → 灰
 * @returns hex 颜色；未知键也稳定（`avatarColor` 按 seed 哈希）
 */
export function communityColor(key: string | null | undefined): string {
  if (key === null || key === undefined || key === "") return UNGROUPED_COLOR;
  return avatarColor(key);
}

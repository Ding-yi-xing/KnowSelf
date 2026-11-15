/**
 * knowSelf 设置分节。
 *
 * V5：声明由插件 schema 自动生成的设置页（`auto: true`），让 dsh 原生设置 chrome
 * 展示 knowSelf 独有设置项。以 dsh 为准的 provider / mcp / 主题 / 语言等设置项
 * 不在此重复，交由 dsh 原生设置。
 *
 * 返回 disposer 供 effect 卸载。
 */
import type { Context } from "@deepseek-ai/cordis";

export function registerSettings(ctx: Context): () => void {
  return ctx.settings.configure({ auto: true });
}

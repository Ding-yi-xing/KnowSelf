/**
 * L1 概要注入分节。
 *
 * 注册一个 system prompt 分节，常驻注入 L1 core 的精简概要；
 * L2/L3 不在此注入，改为工具按需拉取（knowself_search），避免 token 浪费。
 *
 * W2/T03：`text` 改为函数（每次组装重算，profile 变更即时生效）、
 * `interpolate: false`（画像正文是用户可控文本，禁止 `{{var}}` 被插值，
 * 否则构成 prompt 注入面）。契约依据：
 * `@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts:60`（text 支持函数）、
 * `:62`（interpolate?: boolean，默认 true）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { KnowselfServices } from "./services.js";

/** 组装 L1 概要文本（复用领域库 profileStore.core.get）。 */
export function buildL1Summary(services: KnowselfServices): string {
  const core = services.profileStore.core.get();
  const cards = services.profileStore.cards.list();
  const lines: string[] = [];
  lines.push("# 用户画像 (L1)");
  lines.push(`- 显示名: ${core.display_name || "(未命名)"}`);
  lines.push(`- 语言区域: ${core.locale}`);
  lines.push(`- 分区标签: ${(core.section_tags ?? []).join(", ") || "(无)"}`);
  const digest = (core.body ?? "").slice(0, 500);
  lines.push(`- 概要: ${digest}`);
  lines.push(`- 卡片数: ${cards.length}`);
  return lines.join("\n");
}

/**
 * 注册 L1 概要分节到 ctx.systemPrompt。
 * @returns 卸载 disposer
 */
export async function registerSystemPrompt(
  ctx: Context,
  services: KnowselfServices,
): Promise<() => void> {
  return ctx.systemPrompt.section({
    name: "knowself-l1",
    order: 50,
    // 每次组装都会调用（契约 :60），profile 变更即时生效；失败降级为空串而非抛错。
    text: () => {
      try {
        return buildL1Summary(services);
      } catch {
        return "";
      }
    },
    // 画像正文是用户可控文本，保留字面 `{{var}}`（契约 :62）。
    interpolate: false,
  });
}

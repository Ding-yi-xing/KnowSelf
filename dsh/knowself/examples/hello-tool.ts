/**
 * Hello 工具样例 —— 证明「一个 knowSelf 工具」挂载进 dsh 的最小可运行形态。
 *
 * ⚠️ 运行前提（缺一不可）：
 *   1. Node >= 24.9.0（dsh engines 要求；当前 shell 若仍报 22 则需先切换生效）。
 *   2. `pnpm install`（装 @deepseek-ai/cordis + @deepseek-ai/dsh-tools 等 peer）。
 *
 * 本文件是**目标形态示范**：展示了真实工具定义 + apply(ctx) 注册 + ctx.effect 回收。
 * 把它作为 15 个 knowSelf 工具的「照抄模板」。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

/** 一个最小工具：回声，验证链路。 */
const helloTool: ToolDefinition = {
  name: "knowself_hello",
  description: "回声测试：验证 knowSelf 插件工具链路已通。",
  // 入参 = 标准 JSON Schema（可经 schema-bridge 从 zod 生成）
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "要回声的文本" } },
    required: ["text"],
  } as Record<string, unknown>,
  // 出参契约：JSON Schema + render 投影
  output: {
    schema: {
      type: "object",
      properties: { echoed: { type: "string" } },
      required: ["echoed"],
    },
    render: (_args: unknown, value: unknown) => {
      const echoed = (value as { echoed: string }).echoed;
      return [{ type: "text", text: `echoed: ${echoed}` }];
    },
  },
  // 执行：返回 canonical JSON 值（由 output.render 投影成模型文本）
  execute: async (args: unknown) => {
    const { text } = args as { text: string };
    return { echoed: text };
  },
};

/** 插件入口（Object 形式，带 name）。 */
export default {
  name: "knowself-hello",
  apply(ctx: Context): void {
    // ctx.tools.register 返回 disposer；ctx.effect 保证卸载时自动回收
    ctx.effect(() => ctx.tools.register(helloTool));
    ctx.logger("knowself").info("knowself_hello tool registered");
  },
};

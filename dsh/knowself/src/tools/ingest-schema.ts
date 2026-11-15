/**
 * `knowself_ingest` 的手写入参 `parameters`（05 §3 T02 / 04 §1.4 D2）。
 *
 * 真实 Zod（`src/tools.ts`）是
 * `z.discriminatedUnion("kind", [file / url / paste]).and(z.object({ max_proposals?, focus_hints? }))`。
 * zod-to-json-schema 输出 `allOf: [ { anyOf: [3 个分支] }, { type:"object", ... } ]`，
 * 展平 allOf 会丢失判别信息，因此由调用方手写「给模型看的提示」；
 * 真校验仍由 `execute` 首行 `input.parse(args)` 承担（Zod 是唯一真相源）。
 *
 * 字段名严格对齐真实 Zod（**不是** 05 §3 示例里的 text/url/file + content/path）：
 *   - file : kind / name(必填) / mime_type? / file_bytes_base64?
 *   - url  : kind / url(必填)
 *   - paste: kind / name? / text(必填)
 *   - 交叉段: max_proposals? / focus_hints?（每个分支的公共可选字段）
 *
 * dsh 校验器硬约束（实测 @deepseek-ai/dsh-tools@0.2.2-rc.1
 *   `lib/shared-DTdn5dXO.js:156-164, 224-252`）：
 *   1. 顶层**不能**同时声明 `type` 与 `oneOf`（05 §3 的 `{type:"object", oneOf:[...]}`
 *      实测被拒：`schema cannot declare both type and oneOf`）→ 这里用纯 `oneOf`。
 *   2. `oneOf` 至少 2 项；顶层不能有 properties/required/additionalProperties/
 *      items/enum/const → 公共字段只能放进每个分支。
 *   3. `const` 必须挂在**带 type** 的节点上：`{ type:"string", const:"file" }`
 *      （05 §3 示例的 `{const:"text"}` 实测被拒：`const requires type or oneOf`）。
 */
import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";

/** 三个分支共有的可选字段（来自 `.and()` 的第二段）。 */
const COMMON_PROPERTIES = {
  max_proposals: {
    type: "integer",
    description: "最多生成的提案数（可选）",
  },
  focus_hints: {
    type: "array",
    items: { type: "string" },
    description: "蒸馏关注点提示（可选）",
  },
} as const;

export const INGEST_PARAMETERS: JsonSchemaNode = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { type: "string", const: "file", description: "资料类型：内联文件" },
        name: { type: "string", description: "文件名" },
        mime_type: { type: "string", description: "MIME 类型（可选）" },
        file_bytes_base64: {
          type: "string",
          description: "内联文件字节（base64，可选）",
        },
        ...COMMON_PROPERTIES,
      },
      required: ["kind", "name"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", const: "url", description: "资料类型：URL" },
        url: { type: "string", description: "资料 URL" },
        ...COMMON_PROPERTIES,
      },
      required: ["kind", "url"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", const: "paste", description: "资料类型：粘贴文本" },
        name: { type: "string", description: "名称（可选）" },
        text: { type: "string", description: "粘贴正文" },
        ...COMMON_PROPERTIES,
      },
      required: ["kind", "text"],
      additionalProperties: false,
    },
  ],
};

export {};

/**
 * schema-bridge —— zod → JSON Schema 桥接（dsh 强制子集，宽松优先）。
 *
 * 单一真相源仍是 `packages/contracts` 的 Zod；本模块只做一次「给模型看的提示」转换，
 * 真门禁是 `src/tools.ts` 的 execute 首行 `input.parse(args)`。
 * 工具出参 `output.schema` 与插件 `Config` 不经过本模块。
 *
 * 修复 D1/P0（05 §3 T02）：旧实现把 `name` 传给 zod-to-json-schema，产物变成
 * `{ $ref, definitions }`，随后 sanitize 删光 → **全部工具 parameters 都是 `{}`**。
 *
 * 现在 `convert(schema, { $refStrategy: "none", target: "jsonSchema7" })` 不传 name，
 * 再按「宽松优先」降维（05 §3 T02 复评 V3）：
 *   - 判别联合（分支都是 object 且共享 const 判别键）→ anyOf 转 oneOf
 *   - 原始类型联合 / `type: ["string","number"]` 数组 → oneOf
 *   - 可能重叠的 object 联合 → **不生成 oneOf**，降为宽松 object
 *   - `A.and(B)` / allOf → 展平 properties / required
 *   - optional 包装 `anyOf: [{not:{}}, X]` → 取 X
 *   - 最后 sanitize 收敛白名单，禁止 `$ref/$schema/anyOf/allOf/patternProperties/definitions`
 *
 * dsh 校验器硬约束（逐行实测 @deepseek-ai/dsh-tools@0.2.2-rc.1
 *   `lib/shared-DTdn5dXO.js:156-164, 224-252`）：
 *   - 不能同时声明 `type` 与 `oneOf`
 *   - `oneOf` 至少 2 项；`oneOf` 节点旁不能有 properties/required/
 *     additionalProperties/items/enum/const（注解键除外）
 *   - `const` / `enum` / `properties` 等必须挂在带 `type` 或 `oneOf` 的节点上
 *   - `type` 必须是单个字符串（**不支持 type 数组**）
 */
import { zodToJsonSchema as convert } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";

/** dsh `JsonSchemaNode` 强制子集允许的关键字（含注解键）。 */
const ALLOWED_KEYS = new Set([
  "type",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "title",
  "default",
  "examples",
]);

/** 注解键：允许与 oneOf 共存（实测 `oneOf + description` 通过校验）。 */
const ANNOTATION_KEYS = new Set(["description", "title", "default", "examples"]);

/** 与 dsh 校验器 `ONE_OF_SIBLING_KEYWORDS` 对齐：oneOf 节点禁止携带的兄弟键。 */
const ONE_OF_SIBLING_KEYS = new Set([
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
]);

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判别联合：所有分支都是 object，且共享至少一个带 `const` 的同名属性。 */
function isDiscriminatedUnion(branches: unknown[]): boolean {
  if (branches.length < 2) return false;
  const shared = new Set<string>();
  let first = true;
  for (const branch of branches) {
    if (!isRecord(branch) || branch.type !== "object" || !isRecord(branch.properties)) {
      return false;
    }
    const keys = Object.entries(branch.properties)
      .filter(([, schema]) => isRecord(schema) && "const" in schema)
      .map(([key]) => key);
    if (keys.length === 0) return false;
    if (first) {
      for (const key of keys) shared.add(key);
      first = false;
    } else {
      for (const key of shared) {
        if (!keys.includes(key)) shared.delete(key);
      }
    }
  }
  return shared.size > 0;
}

/** 原始类型联合：每个分支都是带单个标量 `type` 的 schema。 */
function isPrimitiveUnion(branches: unknown[]): boolean {
  return (
    branches.length >= 2 &&
    branches.every(
      (branch) =>
        isRecord(branch) &&
        typeof branch.type === "string" &&
        branch.type !== "object",
    )
  );
}

/** optional 包装分支：`{ not: {} }`（zod-to-json-schema 对 undefined 的表达）。 */
function isUndefinedBranch(node: unknown): boolean {
  return isRecord(node) && Object.keys(node).length === 1 && "not" in node;
}

/** 可能重叠的 object 联合 → 宽松 object（并集且全部可选）。 */
function loosenUnion(branches: unknown[]): JsonObject {
  const properties: JsonObject = {};
  for (const branch of branches) {
    if (!isRecord(branch) || !isRecord(branch.properties)) continue;
    for (const [key, schema] of Object.entries(branch.properties)) {
      if (!(key in properties)) properties[key] = schema;
    }
  }
  return { type: "object", properties, additionalProperties: true };
}

/** allOf 展平：合并 properties / required；同键冲突取后者（不下发互斥约束）。 */
function flattenAllOf(parts: unknown[]): JsonObject {
  const merged: JsonObject = { type: "object", properties: {} };
  const required: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (isRecord(part.properties)) {
      Object.assign(merged.properties as JsonObject, part.properties);
    }
    if (Array.isArray(part.required)) {
      for (const key of part.required) {
        if (typeof key === "string" && !required.includes(key)) required.push(key);
      }
    }
  }
  if (required.length > 0) merged.required = required;
  // 展平后信息可能不全，统一放开未声明键，避免把合法入参判违约。
  merged.additionalProperties = true;
  return merged;
}

/**
 * 把 zod-to-json-schema 的原始输出降维到 dsh 强制子集（递归、纯函数）。
 * 不做运行时校验：JSON Schema 只是给模型看的提示，真门禁是 Zod parse。
 */
function desugar(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(desugar);
  if (!isRecord(node)) return node;

  // 1) optional 包装 / anyOf 联合
  if (Array.isArray(node.anyOf)) {
    const branches = node.anyOf as unknown[];
    const rest = branches.filter((branch) => !isUndefinedBranch(branch));
    if (rest.length === 1 && rest.length !== branches.length) {
      // 顶层 `.optional()` 的 undefined 分支：属性缺省由父级 required 表达，取实体分支。
      return desugar(rest[0]);
    }

    const converted = rest.map(desugar);
    const out: JsonObject =
      isDiscriminatedUnion(converted) || isPrimitiveUnion(converted)
        ? { oneOf: converted }
        : loosenUnion(converted);
    for (const key of ANNOTATION_KEYS) {
      if (key in node) out[key] = desugar(node[key]);
    }
    return out;
  }

  // 2) type 数组（zod 的 union / nullable）→ oneOf（dsh 不支持 type 数组）
  if (Array.isArray(node.type)) {
    const types = node.type as unknown[];
    const { type: _type, ...rest } = node;
    void _type;
    const out: JsonObject = {
      oneOf: types.map((type) => desugar({ ...rest, type })),
    };
    for (const key of ANNOTATION_KEYS) {
      if (key in node) out[key] = desugar(node[key]);
    }
    return out;
  }

  // 3) allOf（A.and(B)）→ 展平
  if (Array.isArray(node.allOf)) {
    const { allOf: _allOf, ...rest } = node;
    void _allOf;
    const merged = flattenAllOf((node.allOf as unknown[]).map(desugar));
    return desugar({ ...rest, ...merged });
  }

  // 4) 普通对象：递归处理每个值
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = desugar(value);
  }
  return out;
}

/**
 * 白名单收敛：只保留 dsh 支持的关键字，杜绝 `$*` / definitions / anyOf / allOf。
 *
 * 注意 `properties` 的值是「属性名 → 子 schema」映射：**属性名不是关键字**，
 * 必须原样保留，只对每个子 schema 递归。旧实现在这里把属性名也按白名单过滤，
 * 于是 `properties` 恒为 `{}` —— 这是 D1（15 个工具 parameters 全空）的第二个根因
 * （第一个是 `name` 参数导致 `{$ref, definitions}`）。
 */
function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (isRecord(node)) {
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("$") || key === "definitions" || key === "$defs") continue;
      if (!ALLOWED_KEYS.has(key)) continue;
      if (ONE_OF_SIBLING_KEYS.has(key) && "oneOf" in node) continue;
      if (key === "properties" && isRecord(value)) {
        const props: JsonObject = {};
        for (const [propName, propSchema] of Object.entries(value)) {
          props[propName] = sanitize(propSchema);
        }
        out[key] = props;
        continue;
      }
      if (key === "additionalProperties") {
        // dsh 校验器要求该键必须是 boolean（`checkObjectSchemaTail`）。
        // zod-to-json-schema 对 z.record() 会输出「对象形态」的额外属性约束；
        // 按「宽松优先、绝不过度拒绝」统一放宽为 true（等价 JSON Schema 默认）。
        // 实测触发点：BuildContextInputSchema.history.items.additionalProperties。
        out[key] = value === false ? false : true;
        continue;
      }
      out[key] = sanitize(value);
    }
    return out;
  }
  return node;
}

/**
 * 把 zod schema 转成 dsh 工具 `parameters` 所需的 JSON Schema 节点。
 * @param schema 领域库 zod schema（单一真相源）
 * @returns 清洗过的 `JsonSchemaNode`（dsh 强制子集）
 */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchemaNode {
  const raw = convert(schema, { $refStrategy: "none", target: "jsonSchema7" });
  return sanitize(desugar(raw)) as JsonSchemaNode;
}

export {};
